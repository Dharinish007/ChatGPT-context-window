/**
 * ChatGPT Context Monitor - Tool Detector
 * 
 * Observes client-side indicators of Web Search, Python / Advanced Data Analysis,
 * Memory updates, and Connected Apps / MCP invocations.
 * 
 * In strict adherence to project accuracy rules:
 * Tool executions are classified as OBSERVED, while their underlying context
 * token impact (retrieved search snippets, memory vectors, tool schemas)
 * remains classified as UNKNOWN.
 */

export class ToolDetector {
  /**
   * Scans DOM for tool indicators.
   * @param {Document|HTMLElement} root 
   * @returns {{ observed: boolean, list: Array<{ type: string, label: string, status: string, tokenStatus: string }> }}
   */
  detect(root = document) {
    const tools = [];

    // 1. Web Search
    const searchChips = root.querySelectorAll("button[aria-label*='Searched'], div[class*='search-pill'], [data-testid='web-search-citations']");
    if (searchChips && searchChips.length > 0) {
      tools.push({
        type: 'web_search',
        label: `Web Search (${searchChips.length} action${searchChips.length > 1 ? 's' : ''})`,
        status: 'OBSERVED',
        tokenStatus: 'UNKNOWN'
      });
    }

    // 2. Python / Code Interpreter / Advanced Data Analysis
    const codeExecEls = root.querySelectorAll("div[data-testid='code-execution'], button[aria-label*='Ran Python'], button[aria-label*='Finished analyzing']");
    if (codeExecEls && codeExecEls.length > 0) {
      tools.push({
        type: 'code_interpreter',
        label: `Python Code Interpreter (${codeExecEls.length} execution${codeExecEls.length > 1 ? 's' : ''})`,
        status: 'OBSERVED',
        tokenStatus: 'UNKNOWN'
      });
    }

    // 3. Memory Updates or Access
    const memoryEls = root.querySelectorAll("div[data-testid='memory-updated'], button[aria-label*='Memory updated'], button[aria-label*='Memory accessed']");
    if (memoryEls && memoryEls.length > 0) {
      tools.push({
        type: 'memory',
        label: 'Memory Reference / Update',
        status: 'OBSERVED',
        tokenStatus: 'UNKNOWN'
      });
    }

    // 4. Canvas / Artifacts
    const canvasEls = root.querySelectorAll("[data-testid='canvas-container'], button[aria-label*='Open canvas']");
    if (canvasEls && canvasEls.length > 0) {
      tools.push({
        type: 'canvas',
        label: 'Canvas Editor / Artifact',
        status: 'OBSERVED',
        tokenStatus: 'UNKNOWN'
      });
    }

    // 5. Apps / MCP / Custom GPT Tools
    const appEls = root.querySelectorAll("[data-testid='mcp-tool-pill'], [data-testid='connected-app-pill'], button[aria-label*='Used tool']");
    if (appEls && appEls.length > 0) {
      tools.push({
        type: 'apps_mcp',
        label: `Apps / MCP Tools (${appEls.length} call${appEls.length > 1 ? 's' : ''})`,
        status: 'OBSERVED',
        tokenStatus: 'UNKNOWN'
      });
    }

    return {
      observed: tools.length > 0,
      list: tools
    };
  }
}
