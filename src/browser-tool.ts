/**
 * Browser Tool for pray-bot
 *
 * Playwright 기반 브라우저 자동화 Tool.
 * 여러 모드를 지원하여 다양한 사용 케이스에 대응.
 *
 * @see docs/BROWSER_TOOL.md
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import path from "path";
import fs from "fs";
import type { ToolDefinition, ToolExecutionResult } from "./tools.ts";

// ============================================================================
// Types
// ============================================================================

type BrowserMode = "headless" | "headful" | "persistent";

type BrowserAction =
  | "start"
  | "stop"
  | "status"
  | "navigate"
  | "snapshot"
  | "screenshot"
  | "click"
  | "type"
  | "press"
  | "select"
  | "wait"
  | "evaluate"
  | "pdf"
  | "go-headless";

type BrowserToolInput = {
  action: BrowserAction;
  // start options
  mode?: BrowserMode;
  // navigate options
  url?: string;
  // interaction options
  selector?: string;
  text?: string;
  key?: string;
  value?: string;
  values?: string[];
  // wait options
  timeout?: number;
  waitFor?: "load" | "domcontentloaded" | "networkidle";
  // screenshot options
  fullPage?: boolean;
  path?: string;
  // evaluate options
  script?: string;
};

type BrowserState = {
  browser: Browser | null;
  context: BrowserContext | null;
  page: Page | null;
  mode: BrowserMode | null;
  startedAt: number | null;
};

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_DATA_DIR = path.join(process.cwd(), ".browser-session");
const DEFAULT_TIMEOUT = 30000;
const MAX_SNAPSHOT_LENGTH = 8000;
const MAX_SCREENSHOT_SIZE = 5 * 1024 * 1024; // 5MB

// ============================================================================
// State (Singleton)
// ============================================================================

const state: BrowserState = {
  browser: null,
  context: null,
  page: null,
  mode: null,
  startedAt: null,
};

// ============================================================================
// Helper Functions
// ============================================================================

function ensurePage(): Page {
  if (!state.page) {
    throw new Error("브라우저가 시작되지 않았습니다. action: start를 먼저 실행하세요.");
  }
  return state.page;
}

function truncate(value: string, limit: number = MAX_SNAPSHOT_LENGTH): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}\n... (truncated, total: ${value.length} chars)`;
}

async function ensureDataDir(): Promise<void> {
  if (!fs.existsSync(DEFAULT_DATA_DIR)) {
    fs.mkdirSync(DEFAULT_DATA_DIR, { recursive: true });
  }
}

// ============================================================================
// Actions
// ============================================================================

async function actionStart(input: BrowserToolInput): Promise<ToolExecutionResult> {
  if (state.browser || state.context) {
    return {
      status: "error",
      data: { reason: "already_running", mode: state.mode },
      userMessage: `브라우저가 이미 실행 중입니다 (mode: ${state.mode}). 먼저 stop을 호출하세요.`,
    };
  }

  const mode: BrowserMode = input.mode ?? "headful";

  try {
    if (mode === "persistent") {
      // Persistent Context: 로그인 상태 저장
      await ensureDataDir();
      state.context = await chromium.launchPersistentContext(DEFAULT_DATA_DIR, {
        headless: false,
        viewport: { width: 1280, height: 800 },
      });
      const pages = state.context.pages();
      state.page = pages[0] || (await state.context.newPage());
      state.browser = null; // persistent context에서는 browser 객체 없음
    } else {
      // Regular Browser
      const headless = mode === "headless";
      state.browser = await chromium.launch({
        headless,
        args: headless ? [] : ["--start-maximized"],
      });
      state.context = await state.browser.newContext({
        viewport: headless ? { width: 1280, height: 800 } : null,
      });
      state.page = await state.context.newPage();
    }

    state.mode = mode;
    state.startedAt = Date.now();

    const modeDescriptions: Record<BrowserMode, string> = {
      headless: "백그라운드 실행 (창 없음, 포커스 안 뺏김)",
      headful: "창 표시 (로그인/디버깅용, 완료 후 go-headless로 전환 가능)",
      persistent: "영구 세션 (로그인 상태 저장, 재시작해도 유지)",
    };

    return {
      status: "success",
      data: { mode, headless: mode === "headless" },
      userMessage: `브라우저 시작 완료\n모드: ${mode}\n설명: ${modeDescriptions[mode]}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "error",
      data: { reason: "launch_failed", message },
      userMessage: `브라우저 시작 실패: ${message}`,
    };
  }
}

async function actionStop(): Promise<ToolExecutionResult> {
  if (!state.browser && !state.context) {
    return {
      status: "success",
      data: { wasRunning: false },
      userMessage: "브라우저가 실행 중이 아닙니다.",
    };
  }

  const duration = state.startedAt ? Date.now() - state.startedAt : 0;
  const previousMode = state.mode;

  try {
    if (state.context) {
      await state.context.close();
    }
    if (state.browser) {
      await state.browser.close();
    }
  } catch (error) {
    // Ignore close errors
  }

  state.browser = null;
  state.context = null;
  state.page = null;
  state.mode = null;
  state.startedAt = null;

  return {
    status: "success",
    data: { wasRunning: true, previousMode, durationMs: duration },
    userMessage: `브라우저 종료 완료 (실행 시간: ${Math.round(duration / 1000)}초)`,
  };
}

async function actionStatus(): Promise<ToolExecutionResult> {
  if (!state.page) {
    return {
      status: "success",
      data: { running: false },
      userMessage: "브라우저가 실행 중이 아닙니다.",
    };
  }

  const url = state.page.url();
  const title = await state.page.title().catch(() => "(unknown)");
  const duration = state.startedAt ? Date.now() - state.startedAt : 0;

  return {
    status: "success",
    data: {
      running: true,
      mode: state.mode,
      url,
      title,
      durationMs: duration,
    },
    userMessage: [
      "브라우저 상태:",
      `- 모드: ${state.mode}`,
      `- URL: ${url}`,
      `- 제목: ${title}`,
      `- 실행 시간: ${Math.round(duration / 1000)}초`,
    ].join("\n"),
  };
}

async function actionNavigate(input: BrowserToolInput): Promise<ToolExecutionResult> {
  const page = ensurePage();
  const url = input.url?.trim();

  if (!url) {
    return {
      status: "error",
      data: { reason: "missing_url" },
      userMessage: "URL이 필요합니다.",
    };
  }

  try {
    const waitUntil = input.waitFor ?? "load";
    const timeout = input.timeout ?? DEFAULT_TIMEOUT;

    await page.goto(url, { waitUntil, timeout });

    const title = await page.title().catch(() => "(unknown)");
    const finalUrl = page.url();

    return {
      status: "success",
      data: { url: finalUrl, title },
      userMessage: `페이지 이동 완료\nURL: ${finalUrl}\n제목: ${title}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "error",
      data: { reason: "navigation_failed", url, message },
      userMessage: `페이지 이동 실패: ${message}`,
    };
  }
}

async function actionSnapshot(): Promise<ToolExecutionResult> {
  const page = ensurePage();

  try {
    const url = page.url();
    const title = await page.title().catch(() => "(unknown)");

    // 페이지 텍스트 추출
    const text = await page.evaluate((): string => {
      // @ts-expect-error - DOM is available in browser context
      const clone = document.body.cloneNode(true);
      clone.querySelectorAll("script, style, noscript").forEach((el: any) => el.remove());
      return clone.innerText || "";
    });

    // 간단한 구조 정보
    const structure = await page.evaluate((): string => {
      const getStructure = (el: any, depth: number = 0): string => {
        if (depth > 3) return "";
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : "";
        const cls = el.className && typeof el.className === "string"
          ? `.${el.className.split(" ").slice(0, 2).join(".")}`
          : "";
        const children = Array.from(el.children)
          .slice(0, 5)
          .map((child: any) => getStructure(child, depth + 1))
          .filter(Boolean)
          .join("\n");
        const indent = "  ".repeat(depth);
        const line = `${indent}<${tag}${id}${cls}>`;
        return children ? `${line}\n${children}` : line;
      };
      // @ts-expect-error - DOM is available in browser context
      return getStructure(document.body);
    });

    return {
      status: "success",
      data: { url, title, textLength: text.length },
      text: truncate(text),
      userMessage: [
        `페이지 스냅샷`,
        `URL: ${url}`,
        `제목: ${title}`,
        ``,
        `[구조]`,
        truncate(structure, 2000),
        ``,
        `[텍스트]`,
        truncate(text, 3000),
      ].join("\n"),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "error",
      data: { reason: "snapshot_failed", message },
      userMessage: `스냅샷 실패: ${message}`,
    };
  }
}

async function actionScreenshot(input: BrowserToolInput): Promise<ToolExecutionResult> {
  const page = ensurePage();

  try {
    const fullPage = input.fullPage ?? false;
    const buffer = await page.screenshot({
      type: "png",
      fullPage,
    });

    if (buffer.byteLength > MAX_SCREENSHOT_SIZE) {
      return {
        status: "error",
        data: { reason: "screenshot_too_large", size: buffer.byteLength },
        userMessage: `스크린샷이 너무 큽니다 (${Math.round(buffer.byteLength / 1024)}KB). fullPage: false로 시도하세요.`,
      };
    }

    const base64 = buffer.toString("base64");
    const url = page.url();

    // 파일로 저장 (선택)
    let savedPath: string | undefined;
    if (input.path) {
      const savePath = path.resolve(input.path);
      fs.writeFileSync(savePath, buffer);
      savedPath = savePath;
    }

    return {
      status: "success",
      data: {
        url,
        fullPage,
        size: buffer.byteLength,
        savedPath,
        base64Preview: base64.slice(0, 100) + "...",
      },
      text: base64,
      userMessage: savedPath
        ? `스크린샷 저장 완료: ${savedPath} (${Math.round(buffer.byteLength / 1024)}KB)`
        : `스크린샷 캡처 완료 (${Math.round(buffer.byteLength / 1024)}KB, base64 반환)`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "error",
      data: { reason: "screenshot_failed", message },
      userMessage: `스크린샷 실패: ${message}`,
    };
  }
}

async function actionClick(input: BrowserToolInput): Promise<ToolExecutionResult> {
  const page = ensurePage();
  const selector = input.selector?.trim();

  if (!selector) {
    return {
      status: "error",
      data: { reason: "missing_selector" },
      userMessage: "selector가 필요합니다.",
    };
  }

  try {
    const timeout = input.timeout ?? DEFAULT_TIMEOUT;
    await page.click(selector, { timeout });

    return {
      status: "success",
      data: { selector },
      userMessage: `클릭 완료: ${selector}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "error",
      data: { reason: "click_failed", selector, message },
      userMessage: `클릭 실패 (${selector}): ${message}`,
    };
  }
}

async function actionType(input: BrowserToolInput): Promise<ToolExecutionResult> {
  const page = ensurePage();
  const selector = input.selector?.trim();
  const text = input.text ?? "";

  if (!selector) {
    return {
      status: "error",
      data: { reason: "missing_selector" },
      userMessage: "selector가 필요합니다.",
    };
  }

  try {
    const timeout = input.timeout ?? DEFAULT_TIMEOUT;
    // fill은 기존 값을 지우고 입력
    await page.fill(selector, text, { timeout });

    return {
      status: "success",
      data: { selector, textLength: text.length },
      userMessage: `텍스트 입력 완료: ${selector} (${text.length}자)`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "error",
      data: { reason: "type_failed", selector, message },
      userMessage: `텍스트 입력 실패 (${selector}): ${message}`,
    };
  }
}

async function actionPress(input: BrowserToolInput): Promise<ToolExecutionResult> {
  const page = ensurePage();
  const key = input.key?.trim();

  if (!key) {
    return {
      status: "error",
      data: { reason: "missing_key" },
      userMessage: "key가 필요합니다. 예: Enter, Tab, Escape, ArrowDown",
    };
  }

  try {
    await page.keyboard.press(key);

    return {
      status: "success",
      data: { key },
      userMessage: `키 입력 완료: ${key}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "error",
      data: { reason: "press_failed", key, message },
      userMessage: `키 입력 실패 (${key}): ${message}`,
    };
  }
}

async function actionSelect(input: BrowserToolInput): Promise<ToolExecutionResult> {
  const page = ensurePage();
  const selector = input.selector?.trim();
  const values = input.values ?? (input.value ? [input.value] : []);

  if (!selector) {
    return {
      status: "error",
      data: { reason: "missing_selector" },
      userMessage: "selector가 필요합니다.",
    };
  }

  if (values.length === 0) {
    return {
      status: "error",
      data: { reason: "missing_values" },
      userMessage: "value 또는 values가 필요합니다.",
    };
  }

  try {
    const timeout = input.timeout ?? DEFAULT_TIMEOUT;
    const selected = await page.selectOption(selector, values, { timeout });

    return {
      status: "success",
      data: { selector, selected },
      userMessage: `선택 완료: ${selector} → ${selected.join(", ")}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "error",
      data: { reason: "select_failed", selector, message },
      userMessage: `선택 실패 (${selector}): ${message}`,
    };
  }
}

async function actionWait(input: BrowserToolInput): Promise<ToolExecutionResult> {
  const page = ensurePage();
  const timeout = input.timeout ?? 1000;
  const selector = input.selector?.trim();

  try {
    if (selector) {
      // 특정 요소 대기
      await page.waitForSelector(selector, { timeout: timeout });
      return {
        status: "success",
        data: { selector, timeout },
        userMessage: `요소 대기 완료: ${selector}`,
      };
    } else {
      // 단순 시간 대기
      await page.waitForTimeout(timeout);
      return {
        status: "success",
        data: { timeout },
        userMessage: `대기 완료: ${timeout}ms`,
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "error",
      data: { reason: "wait_failed", selector, message },
      userMessage: selector
        ? `요소 대기 실패 (${selector}): ${message}`
        : `대기 실패: ${message}`,
    };
  }
}

async function actionEvaluate(input: BrowserToolInput): Promise<ToolExecutionResult> {
  const page = ensurePage();
  const script = input.script?.trim();

  if (!script) {
    return {
      status: "error",
      data: { reason: "missing_script" },
      userMessage: "script가 필요합니다.",
    };
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const result = await page.evaluate(script);
    const resultStr =
      typeof result === "string" ? result : JSON.stringify(result, null, 2) ?? "undefined";

    return {
      status: "success",
      data: { resultType: typeof result },
      text: truncate(resultStr),
      userMessage: `스크립트 실행 완료:\n${truncate(resultStr, 1000)}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "error",
      data: { reason: "evaluate_failed", message },
      userMessage: `스크립트 실행 실패: ${message}`,
    };
  }
}

async function actionPdf(input: BrowserToolInput): Promise<ToolExecutionResult> {
  const page = ensurePage();
  const savePath = input.path ?? path.join(process.cwd(), `page-${Date.now()}.pdf`);

  try {
    const buffer = await page.pdf({
      format: "A4",
      printBackground: true,
    });

    fs.writeFileSync(savePath, buffer);

    return {
      status: "success",
      data: { path: savePath, size: buffer.byteLength },
      userMessage: `PDF 저장 완료: ${savePath} (${Math.round(buffer.byteLength / 1024)}KB)`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "error",
      data: { reason: "pdf_failed", message },
      userMessage: `PDF 저장 실패: ${message}`,
    };
  }
}

async function actionGoHeadless(): Promise<ToolExecutionResult> {
  if (!state.page || !state.context) {
    return {
      status: "error",
      data: { reason: "not_running" },
      userMessage: "브라우저가 실행 중이 아닙니다.",
    };
  }

  if (state.mode === "headless") {
    return {
      status: "success",
      data: { alreadyHeadless: true },
      userMessage: "이미 headless 모드입니다.",
    };
  }

  try {
    // 현재 상태 저장
    const currentUrl = state.page.url();
    const cookies = await state.context.cookies();
    const storageState = await state.context.storageState();

    // 기존 브라우저 종료
    if (state.context) {
      await state.context.close();
    }
    if (state.browser) {
      await state.browser.close();
    }

    // Headless로 재시작
    state.browser = await chromium.launch({ headless: true });
    state.context = await state.browser.newContext({
      storageState,
      viewport: { width: 1280, height: 800 },
    });
    await state.context.addCookies(cookies);
    state.page = await state.context.newPage();

    // 이전 URL로 이동
    if (currentUrl && currentUrl !== "about:blank") {
      await state.page.goto(currentUrl, { waitUntil: "domcontentloaded" });
    }

    state.mode = "headless";

    return {
      status: "success",
      data: { mode: "headless", url: currentUrl },
      userMessage: `Headless 모드로 전환 완료. 이제 포커스를 뺏지 않습니다.\n현재 URL: ${currentUrl}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "error",
      data: { reason: "headless_switch_failed", message },
      userMessage: `Headless 전환 실패: ${message}`,
    };
  }
}

// ============================================================================
// Main Tool Definition
// ============================================================================

export function createBrowserTool(): ToolDefinition<BrowserToolInput> {
  return {
    name: "browser",
    description: [
      "Playwright 기반 브라우저 자동화 도구.",
      "모드: headless (백그라운드), headful (창 표시), persistent (로그인 유지).",
      "주요 액션: start, stop, navigate, snapshot, screenshot, click, type, press, select, wait, evaluate, pdf, go-headless.",
      "로그인이 필요하면 headful/persistent로 시작 → 로그인 완료 → go-headless로 백그라운드 전환.",
    ].join(" "),
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          description:
            "실행할 액션: start, stop, status, navigate, snapshot, screenshot, click, type, press, select, wait, evaluate, pdf, go-headless",
          enum: [
            "start",
            "stop",
            "status",
            "navigate",
            "snapshot",
            "screenshot",
            "click",
            "type",
            "press",
            "select",
            "wait",
            "evaluate",
            "pdf",
            "go-headless",
          ],
        },
        mode: {
          type: "string",
          description:
            "브라우저 모드 (start 전용): headless (백그라운드), headful (창 표시), persistent (로그인 저장)",
          enum: ["headless", "headful", "persistent"],
        },
        url: {
          type: "string",
          description: "이동할 URL (navigate 전용)",
        },
        selector: {
          type: "string",
          description: "CSS 선택자 (click, type, select, wait 전용)",
        },
        text: {
          type: "string",
          description: "입력할 텍스트 (type 전용)",
        },
        key: {
          type: "string",
          description: "입력할 키 (press 전용). 예: Enter, Tab, Escape",
        },
        value: {
          type: "string",
          description: "선택할 값 (select 전용)",
        },
        values: {
          type: "array",
          items: { type: "string" },
          description: "선택할 값들 (select 전용, 다중 선택)",
        },
        timeout: {
          type: "number",
          description: "타임아웃 밀리초. 기본값: 30000",
        },
        waitFor: {
          type: "string",
          description: "페이지 로드 대기 조건 (navigate 전용): load, domcontentloaded, networkidle",
          enum: ["load", "domcontentloaded", "networkidle"],
        },
        fullPage: {
          type: "boolean",
          description: "전체 페이지 캡처 여부 (screenshot 전용). 기본값: false",
        },
        path: {
          type: "string",
          description: "저장 경로 (screenshot, pdf 전용)",
        },
        script: {
          type: "string",
          description: "실행할 JavaScript (evaluate 전용)",
        },
      },
      required: ["action"],
    },
    async execute(input: BrowserToolInput): Promise<ToolExecutionResult> {
      const action = input.action;

      switch (action) {
        case "start":
          return actionStart(input);
        case "stop":
          return actionStop();
        case "status":
          return actionStatus();
        case "navigate":
          return actionNavigate(input);
        case "snapshot":
          return actionSnapshot();
        case "screenshot":
          return actionScreenshot(input);
        case "click":
          return actionClick(input);
        case "type":
          return actionType(input);
        case "press":
          return actionPress(input);
        case "select":
          return actionSelect(input);
        case "wait":
          return actionWait(input);
        case "evaluate":
          return actionEvaluate(input);
        case "pdf":
          return actionPdf(input);
        case "go-headless":
          return actionGoHeadless();
        default:
          return {
            status: "error",
            data: { reason: "unknown_action", action },
            userMessage: `알 수 없는 액션: ${action}`,
          };
      }
    },
  };
}

// ============================================================================
// Utility: Get current browser state (for external access)
// ============================================================================

export function getBrowserState(): {
  running: boolean;
  mode: BrowserMode | null;
  url: string | null;
} {
  return {
    running: state.page !== null,
    mode: state.mode,
    url: state.page?.url() ?? null,
  };
}

// ============================================================================
// Utility: Cleanup on process exit
// ============================================================================

async function cleanup() {
  if (state.context) {
    await state.context.close().catch(() => {});
  }
  if (state.browser) {
    await state.browser.close().catch(() => {});
  }
}

process.on("exit", () => {
  cleanup();
});

process.on("SIGINT", async () => {
  await cleanup();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await cleanup();
  process.exit(0);
});
