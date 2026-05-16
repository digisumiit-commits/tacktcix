import { PaperclipIssue, Agent } from '../types';

export interface PaperclipClientConfig {
  baseUrl: string;
  companyId: string;
  agentId: string;
  apiKey?: string;
}

export class PaperclipClient {
  private config: PaperclipClientConfig;

  constructor(config: PaperclipClientConfig) {
    this.config = config;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) {
      h['Authorization'] = `Bearer ${this.config.apiKey}`;
    }
    return h;
  }

  private url(path: string): string {
    return `${this.config.baseUrl}${path}`;
  }

  async getMe(): Promise<Agent> {
    const res = await fetch(this.url('/api/agents/me'), { headers: this.headers() });
    if (!res.ok) throw new Error(`getMe failed: ${res.status}`);
    return res.json() as Promise<Agent>;
  }

  async getAssignedIssues(params: {
    status?: string;
  } = {}): Promise<PaperclipIssue[]> {
    const { status = 'todo,in_progress,in_review,blocked' } = params;
    const url = this.url(
      `/api/companies/${this.config.companyId}/issues?assigneeAgentId=${this.config.agentId}&status=${status}`
    );
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`getAssignedIssues failed: ${res.status}`);
    return res.json() as Promise<PaperclipIssue[]>;
  }

  async getIssue(issueId: string): Promise<PaperclipIssue> {
    const res = await fetch(
      this.url(`/api/issues/${issueId}`),
      { headers: this.headers() }
    );
    if (!res.ok) throw new Error(`getIssue failed: ${res.status}`);
    return res.json() as Promise<PaperclipIssue>;
  }

  async checkoutIssue(
    issueId: string,
    runId: string
  ): Promise<{ claimed: boolean }> {
    const res = await fetch(
      this.url(`/api/issues/${issueId}/checkout`),
      {
        method: 'POST',
        headers: { ...this.headers(), 'X-Paperclip-Run-Id': runId },
        body: JSON.stringify({}),
      }
    );
    if (res.status === 409) return { claimed: false };
    if (!res.ok) throw new Error(`checkoutIssue failed: ${res.status}`);
    return { claimed: true };
  }

  async updateIssue(
    issueId: string,
    runId: string,
    update: {
      status?: string;
      comment?: string;
      assigneeAgentId?: string;
      blockedByIssueIds?: string[];
    }
  ): Promise<void> {
    const res = await fetch(
      this.url(`/api/issues/${issueId}`),
      {
        method: 'PATCH',
        headers: { ...this.headers(), 'X-Paperclip-Run-Id': runId },
        body: JSON.stringify(update),
      }
    );
    if (!res.ok) throw new Error(`updateIssue failed: ${res.status}`);
  }

  async createIssue(
    runId: string,
    issue: {
      title: string;
      description: string;
      status?: string;
      priority?: string;
      assigneeAgentId?: string;
      parentId?: string;
      goalId?: string;
    }
  ): Promise<PaperclipIssue> {
    const res = await fetch(
      this.url(`/api/companies/${this.config.companyId}/issues`),
      {
        method: 'POST',
        headers: { ...this.headers(), 'X-Paperclip-Run-Id': runId },
        body: JSON.stringify(issue),
      }
    );
    if (!res.ok) throw new Error(`createIssue failed: ${res.status}`);
    return res.json() as Promise<PaperclipIssue>;
  }
}
