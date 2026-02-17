/**
 * Tool abstraction for pray-bot
 * Minimal interface for tool registration and execution
 */

export type JsonSchema = Record<string, unknown>;

export type ToolExecutionStatus = "success" | "error";

export type ToolExecutionResult = {
  status: ToolExecutionStatus;
  data?: Record<string, unknown>;
  text?: string;
  userMessage?: string;
};

export interface ToolDefinition<TInput = Record<string, unknown>> {
  name: string;
  description: string;
  schema: JsonSchema;
  execute(input: TInput): Promise<ToolExecutionResult>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  hasTools(): boolean {
    return this.tools.size > 0;
  }
}
