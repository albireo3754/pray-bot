import { expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { runCodexAppServerTurn } from './client.ts';

test('runCodexAppServerTurn handles approval + user input RPC roundtrip', async () => {
  const scriptPath = join(tmpdir(), `mock-codex-app-server-${Date.now()}-${Math.random()}.cjs`);

  const script = String.raw`
const readline = require('node:readline');

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n');
}

 rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { userAgent: 'mock' } });
    return;
  }

  if (msg.method === 'thread/start') {
    send({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'thread-mock' } } });
    return;
  }

  if (msg.method === 'thread/resume') {
    send({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: msg.params.threadId } } });
    return;
  }

  if (msg.method === 'turn/start') {
    send({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn-mock', status: 'inProgress' } } });
    send({
      jsonrpc: '2.0',
      id: 9001,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-mock',
        turnId: 'turn-mock',
        itemId: 'cmd-1',
        command: 'echo test',
        cwd: '/repo',
      },
    });
    return;
  }

  if (msg.id === 9001) {
    send({
      jsonrpc: '2.0',
      id: 9002,
      method: 'item/fileChange/requestApproval',
      params: {
        threadId: 'thread-mock',
        turnId: 'turn-mock',
        itemId: 'file-1',
      },
    });
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }

  if (msg.id === 9002) {
    send({
      jsonrpc: '2.0',
      id: 9003,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-mock',
        turnId: 'turn-mock',
        itemId: 'input-1',
        questions: [
          {
            id: 'q1',
            header: 'header',
            question: 'question',
            isOther: false,
            isSecret: false,
            options: [{ label: 'yes', description: 'desc' }],
          },
        ],
      },
    });
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }

  if (msg.id === 9003) {
    send({
      jsonrpc: '2.0',
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-mock',
        turnId: 'turn-mock',
        itemId: 'agent-1',
        delta: 'mock assistant ',
      },
    });
    send({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: 'thread-mock',
        turnId: 'turn-mock',
        item: {
          id: 'agent-1',
          type: 'agentMessage',
          text: 'mock assistant final response',
        },
      },
    });
    send({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        threadId: 'thread-mock',
        turn: {
          id: 'turn-mock',
          status: 'completed',
          error: null,
        },
      },
    });
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }

  if (msg.id != null && msg.method == null) {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
});
`;

  await Bun.write(scriptPath, script);

  const called = {
    command: false,
    file: false,
    input: false,
  };

  try {
    const result = await runCodexAppServerTurn({
      cwd: process.cwd(),
      prompt: 'hello',
      command: process.execPath,
      args: [scriptPath],
      onCommandExecutionApproval: async () => {
        called.command = true;
        return 'accept';
      },
      onFileChangeApproval: async () => {
        called.file = true;
        return 'accept';
      },
      onToolRequestUserInput: async () => {
        called.input = true;
        return {
          answers: {
            q1: { answers: ['yes'] },
          },
        };
      },
    });

    expect(called.command).toBe(true);
    expect(called.file).toBe(true);
    expect(called.input).toBe(true);
    expect(result.sessionId).toBe('thread-mock');
    expect(result.turnId).toBe('turn-mock');
    expect(result.text).toBe('mock assistant final response');
  } finally {
    await unlink(scriptPath).catch(() => {});
  }
});
