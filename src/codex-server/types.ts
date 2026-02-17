export type JsonRpcId = string | number;

export type CommandExecutionApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel';

export type FileChangeApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel';

export interface CommandExecutionRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null;
  command?: string | null;
  cwd?: string | null;
}

export interface FileChangeRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null;
  grantRoot?: string | null;
}

export interface ToolRequestUserInputQuestionOption {
  label: string;
  description: string;
}

export interface ToolRequestUserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: ToolRequestUserInputQuestionOption[] | null;
}

export interface ToolRequestUserInputParams {
  threadId: string;
  turnId: string;
  itemId: string;
  questions: ToolRequestUserInputQuestion[];
}

export interface ToolRequestUserInputAnswer {
  answers: string[];
}

export interface ToolRequestUserInputResponse {
  answers: Record<string, ToolRequestUserInputAnswer | undefined>;
}

export type CodexServerRequest =
  | {
      method: 'item/commandExecution/requestApproval';
      id: JsonRpcId;
      params: CommandExecutionRequestApprovalParams;
    }
  | {
      method: 'item/fileChange/requestApproval';
      id: JsonRpcId;
      params: FileChangeRequestApprovalParams;
    }
  | {
      method: 'item/tool/requestUserInput';
      id: JsonRpcId;
      params: ToolRequestUserInputParams;
    }
  | {
      method: string;
      id: JsonRpcId;
      params: unknown;
    };

export type CodexNotification = {
  method: string;
  params: unknown;
};

export interface ThreadStartParams {
  cwd?: string;
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  experimentalRawEvents: boolean;
}

export interface ThreadResumeParams {
  threadId: string;
  cwd?: string;
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
}

export interface ThreadResponse {
  thread: {
    id: string;
  };
}

export interface TurnStartParams {
  threadId: string;
  input: Array<
    | {
        type: 'text';
        text: string;
        text_elements: unknown[];
      }
    | {
        type: string;
        [key: string]: unknown;
      }
  >;
}

export interface TurnStartResponse {
  turn: {
    id: string;
    status?: string;
  };
}

export interface TurnCompletedNotification {
  threadId: string;
  turn: {
    id: string;
    status: string;
    error?: {
      message: string;
      additionalDetails?: string | null;
    } | null;
  };
}

export interface AgentMessageDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface ItemCompletedNotification {
  threadId: string;
  turnId: string;
  item: {
    id: string;
    type: string;
    text?: string;
    status?: string;
  };
}

export interface ErrorNotification {
  error: {
    message: string;
    additionalDetails?: string | null;
  };
  willRetry: boolean;
  threadId: string;
  turnId: string;
}

export interface RunCodexAppServerTurnResult {
  text: string;
  sessionId: string;
  turnId: string;
}
