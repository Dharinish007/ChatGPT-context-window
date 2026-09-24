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

// One selector group per tool type (same selectors as before, now read in a single page query)
const TOOL_GROUPS = [
  "button[aria-label*='Searched'], div[class*='search-pill'], [data-testid='web-search-citations']",
  "div[data-testid='code-execution'], button[aria-label*='Ran Python'], button[aria-label*='Finished analyzing']",
  "div[data-testid='memory-updated'], button[aria-label*='Memory updated'], button[aria-label*='Memory accessed']",
  "[data-testid='canvas-container'], button[aria-label*='Open canvas']",
  "[data-testid='mcp-tool-pill'], [data-testid='connected-app-pill'], button[aria-label*='Used tool']"
];

/**
 * Elements matching each selector group, in document order, from ONE page traversal instead of one per
 * group (an element matching several groups is listed in each, exactly as separate queries did).
 * @param {Document|Element} root
 * @param {string[]} groups
 * @returns {Element[][]}
 */
export function queryGroups(root, groups) {
  const all = Array.from(root.querySelectorAll(groups.join(', ')) || []);
  if (all.length === 0) return groups.map(() => []);
  if (typeof all[0].matches !== 'function') return groups.map(g => Array.from(root.querySelectorAll(g) || []));
  return groups.map(g => all.filter(el => el.matches(g)));
}

export class ToolDetector {
  /**
   * Scans DOM for tool indicators.
   * @param {Document|HTMLElement} root 
   * @returns {{ observed: boolean, list: Array<{ type: string, label: string, status: string, tokenStatus: string }> }}
   */
  detect(root = document) {
    const tools = [];
    const [searchChips, codeExecEls, memoryEls, canvasEls, appEls] = queryGroups(root, TOOL_GROUPS);

    // 1. Web Search
    if (searchChips && searchChips.length > 0) {
      tools.push({
        type: 'web_search',
        label: `Web Search (${searchChips.length} action${searchChips.length > 1 ? 's' : ''})`,
        status: 'OBSERVED',
        tokenStatus: 'UNKNOWN'
      });
    }

    // 2. Python / Code Interpreter / Advanced Data Analysis
    if (codeExecEls && codeExecEls.length > 0) {
      tools.push({
        type: 'code_interpreter',
        label: `Python Code Interpreter (${codeExecEls.length} execution${codeExecEls.length > 1 ? 's' : ''})`,
        status: 'OBSERVED',
        tokenStatus: 'UNKNOWN'
      });
    }

    // 3. Memory Updates or Access
    if (memoryEls && memoryEls.length > 0) {
      tools.push({
        type: 'memory',
        label: 'Memory Reference / Update',
        status: 'OBSERVED',
        tokenStatus: 'UNKNOWN'
      });
    }

    // 4. Canvas / Artifacts
    if (canvasEls && canvasEls.length > 0) {
      tools.push({
        type: 'canvas',
        label: 'Canvas Editor / Artifact',
        status: 'OBSERVED',
        tokenStatus: 'UNKNOWN'
      });
    }

    // 5. Apps / MCP / Custom GPT Tools
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
