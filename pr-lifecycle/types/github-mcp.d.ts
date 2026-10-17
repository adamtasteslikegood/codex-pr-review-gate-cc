// The GitHub MCP tools the guards read, declared here instead of loading the
// generated claude-code-mcp types (1.6 MB; tsc runs out of memory on them).
export {}
declare module 'claude-code' {
  interface McpToolInputs {
    mcp__plugin_github_github__create_pull_request: { owner: string; repo: string; title: string; head: string; base: string; body?: string; draft?: boolean }
    mcp__plugin_github_github__merge_pull_request: { owner: string; repo: string; pullNumber: number; merge_method?: string }
    'mcp__claude_ai_github-graphql-mcp__manage_pull_requests': {
      action: 'list' | 'get' | 'create' | 'update' | 'close' | 'merge' | 'reopen' | 'add_review' | 'request_reviews' | 'add_comment' | 'enqueue' | 'dequeue'
      repo: string
      base?: string
      head?: string
      number?: number
      title?: string
      body?: string
      merge_method?: 'merge' | 'squash' | 'rebase'
    }
  }
}
