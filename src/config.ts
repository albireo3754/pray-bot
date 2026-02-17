import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import type { ChannelsConfig, ChannelMapping } from './discord/types.ts';

const CHANNELS_CONFIG_PATH = process.env.PRAY_BOT_CHANNELS_FILE ?? './channels.yaml';

/**
 * Load channels.yaml → ChannelMapping[]
 * Returns flat array of all channel mappings with category info.
 */
export function loadChannelsConfig(): ChannelMapping[] {
  const resolved = resolve(CHANNELS_CONFIG_PATH);
  if (!existsSync(resolved)) {
    console.warn(`channels config not found: ${resolved}`);
    return [];
  }

  try {
    const content = readFileSync(resolved, 'utf8');
    const parsed = YAML.parse(content) as ChannelsConfig | null;
    if (!parsed) return [];

    const mappings: ChannelMapping[] = [];

    // Static categories
    if (parsed.categories && typeof parsed.categories === 'object') {
      for (const [category, channels] of Object.entries(parsed.categories)) {
        if (typeof channels !== 'object' || channels === null) continue;
        for (const [key, path] of Object.entries(channels)) {
          if (typeof path === 'string' && path.trim().length > 0) {
            mappings.push({ key: key.trim(), path: path.trim(), category });
          }
        }
      }
    }

    return mappings;
  } catch (error) {
    console.error(`Failed to load channels config from ${resolved}:`, error);
    return [];
  }
}

/**
 * Save a new mapping to channels.yaml
 */
export function saveChannelMapping(key: string, path: string, category: string): void {
  const resolved = resolve(CHANNELS_CONFIG_PATH);
  let parsed: ChannelsConfig = { categories: {} };

  if (existsSync(resolved)) {
    try {
      const content = readFileSync(resolved, 'utf8');
      parsed = YAML.parse(content) ?? { categories: {} };
    } catch { /* use default */ }
  }

  if (!parsed.categories) parsed.categories = {};
  if (!parsed.categories[category]) parsed.categories[category] = {};
  parsed.categories[category][key] = path;

  writeFileSync(resolved, YAML.stringify(parsed), 'utf8');
}

/**
 * Remove a mapping from channels.yaml
 */
export function removeChannelMapping(key: string): boolean {
  const resolved = resolve(CHANNELS_CONFIG_PATH);
  if (!existsSync(resolved)) return false;

  try {
    const content = readFileSync(resolved, 'utf8');
    const parsed = YAML.parse(content) as ChannelsConfig | null;
    if (!parsed?.categories) return false;

    for (const [category, channels] of Object.entries(parsed.categories)) {
      if (channels && key in channels) {
        delete channels[key];
        if (Object.keys(channels).length === 0) {
          delete parsed.categories[category];
        }
        writeFileSync(resolved, YAML.stringify(parsed), 'utf8');
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}
