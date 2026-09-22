/**
 * ChatGPT Context Monitor - Plan Detector
 * 
 * Inspects ChatGPT Web DOM headers, buttons, and navigation elements to identify
 * the user's active ChatGPT subscription plan tier (free, go, plus, pro, team, business, enterprise, edu).
 * 
 * Principle: Detect only from reliable observable signals; never guess.
 */

export const PlanTier = Object.freeze({
  FREE: 'free',
  GO: 'go',
  PLUS: 'plus',
  PRO: 'pro',
  TEAM: 'team',
  BUSINESS: 'business',
  ENTERPRISE: 'enterprise',
  EDU: 'edu',
  UNKNOWN: 'unknown'
});

/**
 * Normalizes an arbitrary plan string into a standard PlanTier.
 * @param {string|null} rawString 
 * @returns {string}
 */
export function normalizePlanTier(rawString) {
  if (!rawString || typeof rawString !== 'string') {
    return PlanTier.UNKNOWN;
  }

  const s = rawString.toLowerCase().trim();

  if (s === 'free' || s.includes('free_tier') || s.includes('free-tier')) {
    return PlanTier.FREE;
  }
  if (s === 'go' || s.includes('chatgpt_go') || s.includes('chatgpt-go')) {
    return PlanTier.GO;
  }
  if (s === 'plus' || s.includes('chatgpt_plus') || s.includes('chatgpt-plus') || s.includes('plus_subscriber')) {
    return PlanTier.PLUS;
  }
  if (s === 'pro' || s.includes('chatgpt_pro') || s.includes('chatgpt-pro') || s.includes('pro_subscriber')) {
    return PlanTier.PRO;
  }
  if (s === 'team' || s.includes('chatgpt_team') || s.includes('chatgpt-team')) {
    return PlanTier.TEAM;
  }
  if (s === 'business' || s.includes('chatgpt_business') || s.includes('chatgpt-business')) {
    return PlanTier.BUSINESS;
  }
  if (s === 'enterprise' || s.includes('chatgpt_enterprise') || s.includes('chatgpt-enterprise')) {
    return PlanTier.ENTERPRISE;
  }
  if (s === 'edu' || s.includes('chatgpt_edu') || s.includes('chatgpt-edu')) {
    return PlanTier.EDU;
  }

  return PlanTier.UNKNOWN;
}

export class PlanDetector {
  /**
   * Scans DOM for observable signals of subscription plan tier.
   * @param {Document|HTMLElement} root 
   * @returns {{ value: string, raw: string|null, source: string, evidenceType: string }}
   */
  detect(root = document) {
    if (!root) {
      return {
        value: PlanTier.UNKNOWN,
        raw: null,
        source: 'unknown',
        evidenceType: 'UNKNOWN'
      };
    }

    // 1. Check for explicit Paid Plan indicators in Profile, Header, or Sidebar
    const profileSelectors = [
      "button[data-testid='profile-button']",
      "button[aria-label*='Profile']",
      "button[data-testid*='user-menu']",
      "div[data-testid='user-profile']",
      "header span[class*='badge']",
      "nav [data-testid*='plan-badge']",
      "[data-testid='workspace-name']"
    ];

    for (const sel of profileSelectors) {
      const el = root.querySelector(sel);
      if (el) {
        const text = (el.innerText || el.textContent || '').trim();
        if (text) {
          if (/\bPro\b/i.test(text)) {
            return { value: PlanTier.PRO, raw: text, source: 'dom', evidenceType: 'OBSERVED' };
          }
          if (/\bEnterprise\b/i.test(text)) {
            return { value: PlanTier.ENTERPRISE, raw: text, source: 'dom', evidenceType: 'OBSERVED' };
          }
          if (/\bTeam\b/i.test(text)) {
            return { value: PlanTier.TEAM, raw: text, source: 'dom', evidenceType: 'OBSERVED' };
          }
          if (/\bBusiness\b/i.test(text)) {
            return { value: PlanTier.BUSINESS, raw: text, source: 'dom', evidenceType: 'OBSERVED' };
          }
          if (/\bEdu\b/i.test(text)) {
            return { value: PlanTier.EDU, raw: text, source: 'dom', evidenceType: 'OBSERVED' };
          }
          if (/\bPlus\b/i.test(text)) {
            return { value: PlanTier.PLUS, raw: text, source: 'dom', evidenceType: 'OBSERVED' };
          }
        }
      }
    }

    // 2. Check sidebar branding or header text (e.g. "ChatGPT Plus", "ChatGPT Pro")
    const headerEl = root.querySelector('header') || root.querySelector('nav');
    if (headerEl) {
      const headerText = (headerEl.innerText || headerEl.textContent || '');
      if (/ChatGPT\s+Pro\b/i.test(headerText)) {
        return { value: PlanTier.PRO, raw: 'ChatGPT Pro', source: 'dom', evidenceType: 'OBSERVED' };
      }
      if (/ChatGPT\s+Enterprise\b/i.test(headerText)) {
        return { value: PlanTier.ENTERPRISE, raw: 'ChatGPT Enterprise', source: 'dom', evidenceType: 'OBSERVED' };
      }
      if (/ChatGPT\s+Team\b/i.test(headerText)) {
        return { value: PlanTier.TEAM, raw: 'ChatGPT Team', source: 'dom', evidenceType: 'OBSERVED' };
      }
      if (/ChatGPT\s+Plus\b/i.test(headerText)) {
        return { value: PlanTier.PLUS, raw: 'ChatGPT Plus', source: 'dom', evidenceType: 'OBSERVED' };
      }
    }

    // 3. Check for Free Tier indicators (Upgrade buttons / links)
    const upgradeSelectors = [
      "a[href*='/checkout']",
      "button[data-testid*='upgrade']",
      "a[href*='/explore']",
      "a[href*='/pricing']",
      "[data-testid*='upgrade-button']"
    ];

    for (const sel of upgradeSelectors) {
      const el = root.querySelector(sel);
      if (el) {
        const text = (el.innerText || el.textContent || '').trim();
        if (/upgrade/i.test(text) || /upgrade to plus/i.test(text) || /upgrade plan/i.test(text)) {
          return {
            value: PlanTier.FREE,
            raw: text,
            source: 'dom',
            evidenceType: 'OBSERVED'
          };
        }
      }
    }

    // Check general navigation elements containing "Upgrade"
    const navLinks = root.querySelectorAll('nav a, nav button, aside a, aside button');
    for (let i = 0; i < navLinks.length; i++) {
      const txt = (navLinks[i].innerText || navLinks[i].textContent || '').trim().toLowerCase();
      if (txt === 'upgrade' || txt === 'upgrade plan' || txt === 'upgrade to plus') {
        return {
          value: PlanTier.FREE,
          raw: txt,
          source: 'dom',
          evidenceType: 'OBSERVED'
        };
      }
    }

    // 4. Default safe fallback: Unknown
    return {
      value: PlanTier.UNKNOWN,
      raw: null,
      source: 'unknown',
      evidenceType: 'UNKNOWN'
    };
  }
}
