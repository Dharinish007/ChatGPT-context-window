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

  // Compact forms seen in account/entitlement fields: "chatgptplusplan", "chatgpt_team_plan",
  // "pro_subscription". Exact match after stripping decoration; anything else stays unknown.
  const compact = s.replace(/[^a-z0-9]/g, '').replace(/^chatgpt/, '').replace(/(plan|subscriber|subscription|tier)$/, '');
  const exact = {
    free: PlanTier.FREE, go: PlanTier.GO, plus: PlanTier.PLUS, pro: PlanTier.PRO, team: PlanTier.TEAM,
    business: PlanTier.BUSINESS, enterprise: PlanTier.ENTERPRISE, edu: PlanTier.EDU
  };
  if (exact[compact]) {
    return exact[compact];
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
        // Upsell buttons ("Upgrade to Pro", "Get Plus") name a plan the user does NOT have
        if (text && !/\b(upgrade|get|try|buy)\b/i.test(text)) {
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
      // "ChatGPT Pro" as a label, not inside an upsell like "Upgrade to ChatGPT Pro" / "Get ChatGPT Plus"
      const label = (plan) => new RegExp(`(?<!(upgrade to|get|try)\\s+)ChatGPT\\s+${plan}\\b`, 'i').test(headerText);
      if (label('Pro')) {
        return { value: PlanTier.PRO, raw: 'ChatGPT Pro', source: 'dom', evidenceType: 'OBSERVED' };
      }
      if (label('Enterprise')) {
        return { value: PlanTier.ENTERPRISE, raw: 'ChatGPT Enterprise', source: 'dom', evidenceType: 'OBSERVED' };
      }
      if (label('Team')) {
        return { value: PlanTier.TEAM, raw: 'ChatGPT Team', source: 'dom', evidenceType: 'OBSERVED' };
      }
      if (label('Plus')) {
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
            source: 'dom_heuristic', // Inferred from an upgrade prompt, not a plan label
            evidenceType: 'ESTIMATED'
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
          source: 'dom_heuristic', // Inferred from an upgrade prompt, not a plan label
          evidenceType: 'ESTIMATED'
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
