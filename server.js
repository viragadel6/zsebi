const express = require('express');
const path = require('path');
const { chromium } = require('playwright');

const BANXA_URL = 'https://checkout.banxa.com/';
const WALLET = '0x87A85efE735d84D38212C47E52dA240a0b22Bf8F';
const FIAT_CURRENCY = 'EUR';
const COIN = 'USDC';
const BLOCKCHAIN = 'Base';
const PAYMENT_METHOD = 'Apple Pay';
const TAX_COUNTRY = 'Hungary';
const TAX_ID = '8497780418';
const DATE_OF_BIRTH = '02-02-2002';
const ROTATION_INTERVAL = 10 * 60 * 1000;
const KEEPALIVE_INTERVAL = 30 * 1000;
const RETRY_DELAY = 60 * 1000;
const MAX_RETRY_DELAY = 15 * 60 * 1000;
const SESSION_CREATION_TIMEOUT = 8 * 60 * 1000;
const KEEPER_BUSY_RESET_MS = 10 * 60 * 1000;
const KEEPER_RETRY_DELAY = 15 * 1000;
const CONSUMED_SETTLE_DELAY = 8000;
const CONSUMED_RECONCILE_TIMEOUT = 45000;
const REPROMPT_CODE_TIMEOUT = 90 * 1000;
const RESERVATION_TTL = 5 * 60 * 1000;
const MAIL_API = 'https://api.mail.tm';
const MAILTM_TIMEOUT_MS = 15000;
const VIEWPORT = { width: 390, height: 844 };
const USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const APPLE_PAY_SELECTOR = '#native-button-APPLE_PAY button, .primer-apple-pay-button';
const CLEAN_CONTEXT_TOLERANCE = 15;
const PORT = 3000;
const CONSENT_ACCEPT_PATTERN = /^(accept all( cookies)?|allow all( cookies)?|accept cookies|accept|agree|allow|got it|ok|okay|i agree|i accept)$/;
const CONSENT_REJECT_PATTERN = /(disagree|do not|don'?t|reject|decline|selected|custom|necessary|essential|manage|preferences|only)/;
const CONSENT_CONTAINER_SELECTOR = '[id*="onetrust" i], [class*="consent" i], [class*="cookie" i], [id*="consent" i], [id*="cookie" i], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
const CODE_INPUT_NEGATIVE_PATTERN = /postal|postcode|zip|promo|referral|coupon|voucher|discount|tax|search|filter/i;
const PRIMARY_STALE_PATTERN = /create order|buy|back|previous|resend|edit|change|cancel|close|apple pay|cookie|consent/i;
const PRIMARY_ACTION_PATTERN = /\b(continue|submit|confirm|verify|next|proceed|send|pay)\b/i;
const PRIMARY_SCOPED_SELECTORS = [
  'form:visible button.bx-button--primary:visible',
  'form:visible button[class*="primary" i]:visible',
  'form:visible button[type="submit"]:visible',
  '[role="dialog"]:visible button.bx-button--primary:visible',
  '[role="dialog"]:visible button[class*="primary" i]:visible',
  '[role="dialog"]:visible button[type="submit"]:visible'
];
const ORDER_PAID_PATTERN = /payment (?:was |is )?(?:successful|succeeded|complete|completed)|successfully paid|order (?:is |has been )?(?:complete|completed|fulfilled)|thank you for your (?:order|purchase)/i;
const ORDER_EXPIRED_PATTERN = /(?:order|quote|payment|session|checkout) (?:has )?expired|no longer available|already been (?:paid|used|processed)|(?:order|checkout) (?:is |has been )?(?:cancelled|canceled)/i;
const NAMED_ENTITIES = { nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

const agents = {
  smallPackage: { key: 'smallPackage', amount: 25.00, live: null, keeperTimer: null, rotationTimer: null, cycleActive: false, keeperBusy: false, keeperBusySince: null, keeperBusyToken: null, consumedQueued: false, failures: 0 },
  booking: { key: 'booking', amount: 62.00, live: null, keeperTimer: null, rotationTimer: null, cycleActive: false, keeperBusy: false, keeperBusySince: null, keeperBusyToken: null, consumedQueued: false, failures: 0 }
};

function emptyPublicSession() {
  return { status: 'pending', sessionId: null, totalEur: null, url: null, button: null, viewport: null, publishedAt: null, reserved: false, reservedAt: null };
}

const state = {
  smallPackage: emptyPublicSession(),
  booking: emptyPublicSession()
};

let browserPromise = null;

process.on('unhandledRejection', err => {
  console.error('unhandled rejection', err);
});

process.on('uncaughtException', err => {
  console.error('unhandled exception', err);
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomString(length, alphabet) {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return result;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function digitsOnly(text) {
  return String(text).replace(/\D/g, '');
}

function normalizeText(text) {
  return String(text === null || text === undefined ? '' : text).replace(/\s+/g, ' ').trim().toLowerCase();
}

function normalizeAmount(text) {
  const rawString = String(text === null || text === undefined ? '' : text).trim();
  const isNegative = /^-/.test(rawString);
  const cleaned = rawString.replace(/[^0-9.,]/g, '');
  if (!/^[0-9]/.test(cleaned)) return NaN;
  if (!/[0-9]$/.test(cleaned)) return NaN;
  const validFormat = /^[0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,][0-9]{1,2})?$/.test(cleaned) || /^[0-9]+(?:[.,][0-9]{1,2})?$/.test(cleaned);
  if (!validFormat) return NaN;
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalized = cleaned;
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) {
      normalized = cleaned.replace(/\./g, '').replace(/,/g, '.');
    } else {
      normalized = cleaned.replace(/,/g, '');
    }
  } else if (lastComma > -1) {
    const decimals = cleaned.length - lastComma - 1;
    if (decimals > 0 && decimals <= 2) {
      normalized = cleaned.replace(/,/g, '.');
    } else {
      normalized = cleaned.replace(/,/g, '');
    }
  } else if (lastDot > -1) {
    const decimals = cleaned.length - lastDot - 1;
    if (decimals > 0 && decimals <= 2) {
      normalized = cleaned;
    } else {
      normalized = cleaned.replace(/\./g, '');
    }
  }
  const value = parseFloat(normalized);
  if (!Number.isFinite(value)) return NaN;
  return isNegative ? -value : value;
}

function extractTotalEur(text) {
  const value = String(text);
  let match = value.match(/([0-9][0-9.,\s]*[0-9]|[0-9])\s*(?:EUR|€)/i);
  if (!match) {
    match = value.match(/(?:EUR|€)\s*([0-9][0-9.,\s]*[0-9]|[0-9])/i);
  }
  if (!match) return NaN;
  return normalizeAmount(match[1]);
}

function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => {
      const code = parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    })
    .replace(/&#(\d+);/g, (match, code) => {
      const parsed = parseInt(code, 10);
      return parsed > 0 && parsed <= 0x10ffff ? String.fromCharCode(parsed) : match;
    })
    .replace(/&([a-z][a-z0-9]*);/gi, (match, name) => {
      const decoded = NAMED_ENTITIES[name.toLowerCase()];
      return decoded === undefined ? match : decoded;
    });
}

function extractVerificationCode(text, expectedLength) {
  const plain = decodeEntities(String(text)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]*>/g, ' '));
  const validLength = typeof expectedLength === 'number' && Number.isFinite(expectedLength) && expectedLength >= 4 && expectedLength <= 8;
  const keywordPattern = /(?:code|verification|verify|otp|one[ -]?time|passcode)\D{0,80}([0-9]{4,8})(?![0-9])/gi;
  const keywordMatches = [];
  let keywordMatch = keywordPattern.exec(plain);
  while (keywordMatch !== null) {
    keywordMatches.push(keywordMatch[1]);
    keywordMatch = keywordPattern.exec(plain);
  }
  if (validLength) {
    const filteredKeyword = keywordMatches.filter(code => code.length === expectedLength);
    if (filteredKeyword.length) {
      const nonYear = filteredKeyword.find(code => !/^(19|20)[0-9]{2}$/.test(code));
      return nonYear || filteredKeyword[0];
    }
  } else if (keywordMatches.length) {
    const nonYear = keywordMatches.find(code => !/^(19|20)[0-9]{2}$/.test(code));
    return nonYear || keywordMatches[0];
  }
  const standalone = [];
  const pattern = /(?:^|[^0-9])([0-9]{4,8})(?![0-9])/g;
  let match = pattern.exec(plain);
  while (match !== null) {
    if (standalone.indexOf(match[1]) === -1) {
      standalone.push(match[1]);
    }
    match = pattern.exec(plain);
  }
  if (!standalone.length) {
    return null;
  }
  if (validLength) {
    const matching = standalone.filter(code => code.length === expectedLength);
    if (matching.length) {
      const nonYearMatch = matching.find(code => !/^(19|20)[0-9]{2}$/.test(code));
      return nonYearMatch || matching[0];
    }
    return null;
  }
  const sixDigit = standalone.find(code => code.length === 6);
  if (sixDigit) {
    return sixDigit;
  }
  const notYear = standalone.find(code => !/^(19|20)[0-9]{2}$/.test(code));
  if (notYear) {
    return notYear;
  }
  return standalone[standalone.length - 1];
}

async function mailtmRequest(pathname, options) {
  const requestTimeoutMs = (options && options.timeoutMs) || MAILTM_TIMEOUT_MS;
  const requestOptions = {
    method: (options && options.method) || 'GET',
    headers: Object.assign({ 'Content-Type': 'application/json' }, (options && options.headers) || {}),
    body: (options && options.body) || undefined,
    signal: AbortSignal.timeout(requestTimeoutMs)
  };
  const response = await fetch(MAIL_API + pathname, requestOptions);
  if (!response.ok) {
    let detail = '';
    try {
      detail = await response.text();
    } catch (err) {
      detail = '';
    }
    throw new Error('mail.tm ' + pathname + ' failed with ' + response.status + (detail ? (': ' + detail) : ''));
  }
  const responseText = await response.text();
  if (!responseText) return null;
  return JSON.parse(responseText);
}

function extractCollection(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload['hydra:member'])) return payload['hydra:member'];
  return [];
}

async function createMailbox() {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const domainsPayload = await mailtmRequest('/domains?page=1');
      const domains = extractCollection(domainsPayload)
        .filter(domain => domain && typeof domain.domain === 'string' && domain.domain && (domain.isActive === undefined || domain.isActive === true) && !domain.isPrivate);
      if (!domains.length) throw new Error('no active public mail.tm domains available');
      const domain = domains[0].domain;
      const address = randomString(10, 'abcdefghijklmnopqrstuvwxyz0123456789') + '@' + domain;
      const password = randomString(32, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
      const account = await mailtmRequest('/accounts', { method: 'POST', body: JSON.stringify({ address: address, password: password }) });
      const tokenPayload = await mailtmRequest('/token', { method: 'POST', body: JSON.stringify({ address: address, password: password }) });
      if (!tokenPayload || !tokenPayload.token) throw new Error('mail.tm token missing');
      return { address: address, token: tokenPayload.token, accountId: (account && account.id) || tokenPayload.id || null, password: password };
    } catch (err) {
      lastError = err;
      if (attempt < 2) {
        await sleep(3000);
      }
    }
  }
  throw lastError || new Error('mailbox creation failed');
}

async function deleteMailbox(mailbox) {
  if (!mailbox || !mailbox.token || !mailbox.accountId) return;
  try {
    await mailtmRequest('/accounts/' + mailbox.accountId, { method: 'DELETE', headers: { Authorization: 'Bearer ' + mailbox.token } });
  } catch (err) {}
}

function isBanxaVerificationCandidate(message) {
  if (!message || !message.id) return false;
  const subject = message.subject || '';
  const fromAddress = (message.from && message.from.address) || '';
  const intro = message.intro || '';
  return /banxa/i.test(subject) || /banxa/i.test(fromAddress) || /banxa/i.test(intro);
}

function scoreVerificationMessage(message) {
  const subject = String((message && message.subject) || '');
  const fromAddress = String((message && message.from && message.from.address) || '');
  const intro = String((message && message.intro) || '');
  let score = 0;
  if (/(verif|verification|verify|code|otp|one[ -]?time|passcode|confirm)/i.test(subject)) score += 8;
  if (/(verif|verification|verify|code|otp|one[ -]?time|passcode)/i.test(intro)) score += 4;
  if (/banxa/i.test(fromAddress)) score += 2;
  if (/banxa/i.test(subject)) score += 1;
  return score;
}

async function waitForVerificationCode(mailbox, knownIds, timeoutMs, expectedLength) {
  const timeout = timeoutMs || 5 * 60 * 1000;
  const checkedIds = knownIds instanceof Set ? new Set(knownIds) : new Set();
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    let messages = [];
    try {
      const messagesPayload = await mailtmRequest('/messages?page=1', {
        headers: { Authorization: 'Bearer ' + mailbox.token },
        timeoutMs: Math.min(MAILTM_TIMEOUT_MS, Math.max(deadline - Date.now(), 1000))
      });
      messages = extractCollection(messagesPayload);
    } catch (err) {
      await sleep(5000);
      continue;
    }
    const candidates = messages.filter(message => isBanxaVerificationCandidate(message) && !checkedIds.has(message.id));
    candidates.sort((left, right) => scoreVerificationMessage(right) - scoreVerificationMessage(left));
    for (const candidate of candidates) {
      if (Date.now() >= deadline) break;
      let detail = null;
      try {
        detail = await mailtmRequest('/messages/' + candidate.id, {
          headers: { Authorization: 'Bearer ' + mailbox.token },
          timeoutMs: Math.min(MAILTM_TIMEOUT_MS, Math.max(deadline - Date.now(), 1000))
        });
      } catch (err) {
        detail = null;
      }
      if (!detail) {
        continue;
      }
      checkedIds.add(candidate.id);
      const html = Array.isArray(detail.html) ? detail.html.join(' ') : (detail.html || '');
      const fields = [detail.text, html, detail.intro, detail.subject, candidate.intro, candidate.subject];
      let found = null;
      for (const field of fields) {
        if (!field) continue;
        const code = extractVerificationCode(field, expectedLength);
        if (code) {
          found = code;
          break;
        }
      }
      if (!found && expectedLength) {
        for (const field of fields) {
          if (!field) continue;
          const code = extractVerificationCode(field, null);
          if (code) {
            found = code;
            break;
          }
        }
      }
      if (found) {
        return { code: found, ids: checkedIds };
      }
    }
    await sleep(5000);
  }
  throw new Error('verification code not received in time');
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true }).then(browser => {
      browser.on('disconnected', () => {
        browserPromise = null;
      });
      return browser;
    });
    browserPromise.catch(() => {
      browserPromise = null;
    });
  }
  return browserPromise;
}

async function closeContextSafely(context) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await context.close();
      return true;
    } catch (err) {}
  }
  return false;
}

async function createAutomationContext() {
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    userAgent: USER_AGENT,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3
  });
  try {
    await context.addInitScript(() => {
      if (window.ApplePaySession) {
        window.__applePaySessionSimulated = false;
        return;
      }
      function ApplePaySessionStub(version, paymentRequest) {
        this.version = version;
        this.paymentRequest = paymentRequest;
      }
      ApplePaySessionStub.prototype.begin = function () {};
      ApplePaySessionStub.prototype.abort = function () {};
      ApplePaySessionStub.prototype.complete = function () {};
      ApplePaySessionStub.supportsVersion = function () { return true; };
      ApplePaySessionStub.canMakePayments = function () { return true; };
      ApplePaySessionStub.canMakePaymentsWithActiveCard = function () { return Promise.resolve(true); };
      ApplePaySessionStub.STATUS_SUCCESS = 1;
      ApplePaySessionStub.STATUS_FAILURE = 0;
      window.ApplePaySession = ApplePaySessionStub;
      window.__applePaySessionSimulated = true;
    });
  } catch (err) {
    await closeContextSafely(context);
    throw err;
  }
  return context;
}

async function canReceivePointerEvents(locator) {
  try {
    return await locator.evaluate(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const viewWidth = window.innerWidth || document.documentElement.clientWidth || 0;
      const viewHeight = window.innerHeight || document.documentElement.clientHeight || 0;
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      if (centerX < 0 || centerX >= viewWidth || centerY < 0 || centerY >= viewHeight) return false;
      const hit = document.elementFromPoint(centerX, centerY);
      if (!hit) return false;
      return el === hit || el.contains(hit) || hit.contains(el);
    });
  } catch (err) {
    return false;
  }
}

async function findApplePayButton(page) {
  const frames = page.frames();
  let visibleFallback = null;
  for (const frame of frames) {
    let count = 0;
    try {
      count = await frame.locator(APPLE_PAY_SELECTOR).count();
    } catch (err) {
      count = 0;
    }
    for (let i = 0; i < count; i++) {
      const candidate = frame.locator(APPLE_PAY_SELECTOR).nth(i);
      let visible = false;
      try {
        visible = await candidate.isVisible();
      } catch (err) {
        visible = false;
      }
      if (!visible) continue;
      if (await canReceivePointerEvents(candidate)) {
        return candidate;
      }
      if (!visibleFallback) {
        visibleFallback = candidate;
      }
    }
  }
  return visibleFallback;
}

async function waitForApplePayButton(page, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const locator = await findApplePayButton(page);
    if (locator) return locator;
    await sleep(1000);
  }
  throw new Error('apple pay button not found');
}

async function dismissConsentOnce(page) {
  const frames = page.frames();
  for (const frame of frames) {
    let containers = [];
    try {
      containers = await frame.locator(CONSENT_CONTAINER_SELECTOR).all();
    } catch (err) {
      containers = [];
    }
    for (const container of containers) {
      let containerVisible = false;
      try {
        containerVisible = await container.isVisible();
      } catch (err) {
        containerVisible = false;
      }
      if (!containerVisible) continue;
      let buttons = [];
      try {
        buttons = await container.locator('button, [role="button"]').all();
      } catch (err) {
        buttons = [];
      }
      for (const button of buttons) {
        const text = normalizeText(await button.textContent().catch(() => ''));
        if (!text) continue;
        if (CONSENT_REJECT_PATTERN.test(text)) continue;
        if (!CONSENT_ACCEPT_PATTERN.test(text)) continue;
        let visible = false;
        try {
          visible = await button.isVisible();
        } catch (err) {
          visible = false;
        }
        if (!visible) continue;
        try {
          await button.click({ timeout: 1200 });
          return true;
        } catch (err) {}
      }
    }
  }
  return false;
}

async function dismissConsentIfPresent(page) {
  for (let pass = 0; pass < 4; pass++) {
    const clicked = await dismissConsentOnce(page);
    if (!clicked) return;
    await sleep(800);
  }
}

async function waitForAnySelector(page, selectors, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if ((await locator.count().catch(() => 0)) > 0 && (await locator.isVisible().catch(() => false))) {
        return selector;
      }
    }
    await sleep(500);
  }
  throw new Error('none of the selectors found: ' + selectors.join(', '));
}

async function looksLikeOptionControl(element) {
  return await element.evaluate(el => {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return false;
    if (el.getAttribute('role') === 'combobox' || el.hasAttribute('aria-haspopup')) return false;
    const className = (el.getAttribute('class') || '').toLowerCase();
    if (className.indexOf('trigger') !== -1) return false;
    if (el.querySelector('input, select, textarea')) return false;
    return true;
  }).catch(() => false);
}

async function isInsideOpenDropdown(element) {
  return await element.evaluate(el => {
    const root = el.closest('[role="listbox"], [class*="listbox" i], [class*="dropdown" i], [class*="menu" i], [class*="options" i], [class*="popup" i], [class*="overlay" i], [class*="select" i], [class*="combobox" i], [class*="portal" i], [class*="modal" i], [class*="search" i]');
    if (!root) return false;
    const style = window.getComputedStyle(root);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = root.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }).catch(() => false);
}

async function readControlSelection(control) {
  if (!control) return null;
  try {
    const tagName = await control.evaluate(el => el.tagName.toLowerCase());
    if (tagName === 'input' || tagName === 'textarea') {
      return normalizeText(await control.inputValue());
    }
    return normalizeText(await control.textContent());
  } catch (err) {
    return null;
  }
}

function selectionMatchesValue(selection, value) {
  if (!selection) return false;
  const wanted = normalizeText(value);
  if (!wanted) return false;
  if (selection === wanted) return true;
  const pattern = new RegExp('(?:^|\\s)' + escapeRegExp(wanted) + '(?:\\s*\\([^)]*\\))?\\s*$', 'i');
  return pattern.test(selection);
}

async function clickOption(page, value, sourceControl) {
  const wanted = normalizeText(value);
  const prefixPattern = new RegExp('^' + escapeRegExp(String(value).trim()) + '(?![.\\w])', 'i');
  const optionSelectors = [
    '[role="listbox"] [role="option"]',
    '[role="option"]',
    '[role="listbox"] li',
    'li[class*="option" i]',
    '[class*="option" i]'
  ];
  const deadline = Date.now() + 20000;
  const strictDeadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const strict = Date.now() < strictDeadline;
    for (let tier = 0; tier < 2; tier++) {
      for (const selector of optionSelectors) {
        const elements = await page.locator(selector).all().catch(() => []);
        for (const element of elements) {
          const visible = await element.isVisible().catch(() => false);
          if (!visible) continue;
          if (strict && !(await isInsideOpenDropdown(element))) continue;
          if (!(await looksLikeOptionControl(element))) continue;
          const text = normalizeText(await element.textContent().catch(() => ''));
          if (!text) continue;
          const matched = tier === 0 ? text === wanted : prefixPattern.test(text);
          if (!matched) continue;
          try {
            await element.click({ timeout: 5000 });
          } catch (err) {
            continue;
          }
          if (!sourceControl) {
            return;
          }
          await sleep(800);
          const selection = await readControlSelection(sourceControl);
          if (!selection || selectionMatchesValue(selection, value)) {
            return;
          }
        }
      }
    }
    await sleep(700);
  }
  throw new Error('option not found: ' + value);
}

async function typeIntoInput(input, value, delayMs) {
  const readOnly = await input.evaluate(el => el.readOnly === true || el.hasAttribute('readonly')).catch(() => false);
  if (readOnly) {
    await input.click({ timeout: 5000 }).catch(() => {});
    return;
  }
  await input.fill('').catch(async () => {
    await input.click({ timeout: 5000 }).catch(() => {});
  });
  try {
    await input.pressSequentially(value, { delay: delayMs });
  } catch (err) {
    await input.fill(value).catch(() => {});
  }
}

async function typeIntoDropdownSearchIfPresent(page, value, control) {
  const candidates = await page.locator('input[type="search"]:visible, input[placeholder*="search" i]:visible, input[placeholder*="filter" i]:visible, input[aria-label*="search" i]:visible').all().catch(() => []);
  let target = null;
  for (const candidate of candidates) {
    if (await isInsideOpenDropdown(candidate)) {
      target = candidate;
      break;
    }
  }
  if (!target && candidates.length === 1) {
    target = candidates[0];
  }
  if (!target && control) {
    const owned = control.locator('input[type="search"], input[placeholder*="search" i]').first();
    if ((await owned.count().catch(() => 0)) > 0 && (await owned.isVisible().catch(() => false))) {
      target = owned;
    }
  }
  if (target) {
    await typeIntoInput(target, value, 60);
    await sleep(1000);
  }
}

async function typeIntoControlOrDropdown(page, control, value) {
  if (control) {
    const tagName = await control.evaluate(el => el.tagName.toLowerCase()).catch(() => '');
    if (tagName === 'input' || tagName === 'textarea') {
      await typeIntoInput(control, value, 60);
      return;
    }
    const nested = control.locator('input, textarea').first();
    if ((await nested.count().catch(() => 0)) > 0 && (await nested.isVisible().catch(() => false))) {
      await typeIntoInput(nested, value, 60);
      return;
    }
  }
  await typeIntoDropdownSearchIfPresent(page, value, control);
}

async function selectAutocomplete(page, triggerSelector, value) {
  const trigger = page.locator(triggerSelector).first();
  await trigger.waitFor({ state: 'visible', timeout: 30000 });
  const tagName = await trigger.evaluate(el => el.tagName.toLowerCase()).catch(() => '');
  let control = trigger;
  if (tagName === 'input' || tagName === 'textarea') {
    await trigger.click({ timeout: 5000 }).catch(() => {});
    await typeIntoInput(trigger, value, 60);
  } else {
    const innerInput = page.locator(triggerSelector + ' input').first();
    const innerUsable = (await innerInput.count().catch(() => 0)) > 0 && (await innerInput.isVisible().catch(() => false));
    if (innerUsable) {
      control = innerInput;
      await innerInput.click({ timeout: 5000 }).catch(() => {});
      await typeIntoInput(innerInput, value, 60);
    } else {
      await trigger.click({ timeout: 10000 }).catch(() => {});
    }
  }
  await sleep(1000);
  await typeIntoDropdownSearchIfPresent(page, value, control);
  await clickOption(page, value, control);
}

async function selectFiatCurrency(page, fiat) {
  const selector = await waitForAnySelector(page, ['#autoCompleteSelectfiat', '#fiat-select'], 30000);
  if (selector === '#autoCompleteSelectfiat') {
    await selectAutocomplete(page, '#autoCompleteSelectfiat', fiat);
    return;
  }
  const nativeSelect = page.locator('#fiat-select');
  try {
    await nativeSelect.selectOption({ label: fiat });
  } catch (err) {
    await nativeSelect.selectOption(fiat);
  }
}

async function selectCoin(page, coin) {
  await selectAutocomplete(page, '#autoCompleteSelectcoin', coin);
}

async function findTriggersForLabel(page, labelText) {
  const wanted = normalizeText(labelText);
  const found = [];
  let labels = [];
  try {
    labels = await page.getByText(new RegExp('^\\s*' + escapeRegExp(labelText) + '\\s*$', 'i')).all();
  } catch (err) {
    labels = [];
  }
  for (const label of labels) {
    let tagName = '';
    try {
      tagName = await label.evaluate(el => el.tagName.toLowerCase());
    } catch (err) {
      tagName = '';
    }
    if (/^h[1-6]$/.test(tagName)) continue;
    let visible = false;
    try {
      visible = await label.isVisible();
    } catch (err) {
      visible = false;
    }
    if (!visible) continue;
    let text = '';
    try {
      text = await label.textContent();
    } catch (err) {
      text = '';
    }
    if (normalizeText(text) !== wanted) continue;
    const container = label.locator('xpath=ancestor-or-self::*[contains(@class,"bx-select-field")][1]').first();
    if ((await container.count().catch(() => 0)) > 0) {
      const containerTrigger = container.locator('[class*="bx-select-field__trigger"]').first();
      if ((await containerTrigger.count().catch(() => 0)) > 0 && (await containerTrigger.isVisible().catch(() => false))) {
        found.push(containerTrigger);
      }
    }
    const siblingTrigger = label.locator('xpath=./following-sibling::*[contains(@class,"bx-select-field__trigger")][1]').first();
    if ((await siblingTrigger.count().catch(() => 0)) > 0 && (await siblingTrigger.isVisible().catch(() => false))) {
      found.push(siblingTrigger);
    }
    const followingTrigger = label.locator('xpath=./following::*[contains(@class,"bx-select-field__trigger")][1]').first();
    if ((await followingTrigger.count().catch(() => 0)) > 0 && (await followingTrigger.isVisible().catch(() => false))) {
      found.push(followingTrigger);
    }
  }
  return found;
}

async function selectFromLabeledControl(page, labelText, value) {
  const exactPattern = new RegExp('^\\s*' + escapeRegExp(labelText) + '\\s*$', 'i');
  const labeledElement = page.getByLabel(exactPattern).first();
  if ((await labeledElement.count().catch(() => 0)) > 0 && (await labeledElement.isVisible().catch(() => false))) {
    const isSelect = await labeledElement.evaluate(el => el.tagName.toLowerCase() === 'select').catch(() => false);
    if (isSelect) {
      try {
        await labeledElement.selectOption({ label: value });
      } catch (err) {
        await labeledElement.selectOption(value).catch(() => {});
      }
      return;
    }
  }
  let opened = false;
  let openedControl = null;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !opened) {
    const comboboxes = await page.getByRole('combobox', { name: exactPattern }).all().catch(() => []);
    for (const combobox of comboboxes) {
      if (!(await combobox.isVisible().catch(() => false))) continue;
      try {
        await combobox.click({ timeout: 5000 });
        opened = true;
        openedControl = combobox;
        break;
      } catch (err) {}
    }
    if (!opened) {
      const triggers = await findTriggersForLabel(page, labelText);
      for (const trigger of triggers) {
        if (!(await trigger.isVisible().catch(() => false))) continue;
        try {
          await trigger.click({ timeout: 5000 });
          opened = true;
          openedControl = trigger;
          break;
        } catch (err) {}
      }
    }
    if (!opened) {
      await sleep(1000);
    }
  }
  if (!opened) {
    throw new Error('control not found for label ' + labelText);
  }
  await sleep(800);
  await typeIntoControlOrDropdown(page, openedControl, value);
  await clickOption(page, value, openedControl);
}

async function fillWalletAddress(page, wallet) {
  const byPlaceholder = page.getByPlaceholder(/enter your wallet address/i).first();
  if ((await byPlaceholder.count().catch(() => 0)) > 0 && (await byPlaceholder.isVisible().catch(() => false))) {
    try {
      await byPlaceholder.fill(wallet);
      return;
    } catch (err) {}
  }
  const byLabel = page.getByLabel(/your wallet address/i).first();
  await byLabel.waitFor({ state: 'visible', timeout: 30000 });
  await byLabel.fill(wallet);
}

async function readWalletValue(page) {
  const byPlaceholder = page.getByPlaceholder(/enter your wallet address/i).first();
  if ((await byPlaceholder.count().catch(() => 0)) > 0 && (await byPlaceholder.isVisible().catch(() => false))) {
    return await byPlaceholder.inputValue().catch(() => '');
  }
  const byLabel = page.getByLabel(/your wallet address/i).first();
  if ((await byLabel.count().catch(() => 0)) > 0) {
    return await byLabel.inputValue().catch(() => '');
  }
  return '';
}

async function fillFiatAmount(page, amount) {
  const input = page.locator('#fiatInput');
  await input.waitFor({ state: 'visible', timeout: 60000 });
  await input.click();
  await input.fill(String(amount));
  await input.press('Tab');
  await sleep(1500);
}

async function ensureFiatAmount(page, amount) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const input = page.locator('#fiatInput');
    const value = await input.inputValue().catch(() => '');
    const parsed = normalizeAmount(value);
    if (Number.isFinite(parsed) && Math.abs(parsed - amount) < 0.01) {
      return;
    }
    await fillFiatAmount(page, amount);
  }
  const finalValue = await page.locator('#fiatInput').inputValue().catch(() => '');
  const finalParsed = normalizeAmount(finalValue);
  if (!(Number.isFinite(finalParsed) && Math.abs(finalParsed - amount) < 0.01)) {
    throw new Error('fiat amount not applied: ' + finalValue);
  }
}

async function readSelectedControlValue(page, labelText) {
  const exactPattern = new RegExp('^\\s*' + escapeRegExp(labelText) + '\\s*$', 'i');
  const comboboxes = await page.getByRole('combobox', { name: exactPattern }).all().catch(() => []);
  for (const combobox of comboboxes) {
    if (!(await combobox.isVisible().catch(() => false))) continue;
    const selection = await readControlSelection(combobox);
    if (selection) return selection;
  }
  const triggers = await findTriggersForLabel(page, labelText);
  for (const trigger of triggers) {
    const selection = await readControlSelection(trigger);
    if (selection) return selection;
  }
  return '';
}

async function verifyOrderFormDetails(page, agent) {
  let problems = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    problems = [];
    const fiatControl = page.locator('#autoCompleteSelectfiat').first();
    const fiatSelection = (await fiatControl.count().catch(() => 0)) > 0 ? await readControlSelection(fiatControl) : null;
    if (fiatSelection !== null && !selectionMatchesValue(fiatSelection, FIAT_CURRENCY)) problems.push('fiat currency');
    const coinControl = page.locator('#autoCompleteSelectcoin').first();
    const coinSelection = (await coinControl.count().catch(() => 0)) > 0 ? await readControlSelection(coinControl) : null;
    if (coinSelection !== null && !selectionMatchesValue(coinSelection, COIN)) problems.push('coin');
    const blockchainSelection = await readSelectedControlValue(page, 'Selected blockchain');
    if (blockchainSelection && !selectionMatchesValue(blockchainSelection, BLOCKCHAIN)) problems.push('blockchain');
    const paymentSelection = await readSelectedControlValue(page, 'Payment method');
    if (paymentSelection && !selectionMatchesValue(paymentSelection, PAYMENT_METHOD)) problems.push('payment method');
    const walletValue = await readWalletValue(page);
    if (walletValue && walletValue !== WALLET) problems.push('wallet address');
    const fiatInput = page.locator('#fiatInput');
    if ((await fiatInput.count().catch(() => 0)) > 0) {
      const amountValue = await fiatInput.inputValue().catch(() => '');
      const amountParsed = normalizeAmount(amountValue);
      if (!(Number.isFinite(amountParsed) && Math.abs(amountParsed - agent.amount) < 0.01)) problems.push('fiat amount');
    }
    if (!problems.length) {
      return;
    }
    if (problems.indexOf('fiat currency') !== -1) {
      await selectFiatCurrency(page, FIAT_CURRENCY).catch(() => {});
    }
    if (problems.indexOf('coin') !== -1) {
      await selectCoin(page, COIN).catch(() => {});
    }
    if (problems.indexOf('blockchain') !== -1) {
      await selectFromLabeledControl(page, 'Selected blockchain', BLOCKCHAIN).catch(() => {});
    }
    if (problems.indexOf('payment method') !== -1) {
      await selectFromLabeledControl(page, 'Payment method', PAYMENT_METHOD).catch(() => {});
    }
    if (problems.indexOf('wallet address') !== -1) {
      await fillWalletAddress(page, WALLET).catch(() => {});
    }
    if (problems.indexOf('fiat amount') !== -1) {
      await fillFiatAmount(page, agent.amount).catch(() => {});
    }
    await sleep(2000);
  }
  throw new Error('order details mismatch: ' + problems.join(', '));
}

async function isQuoteLoading(page) {
  return await page.evaluate(() => {
    const indicators = document.querySelectorAll('[class*="loading" i], [class*="spinner" i], [class*="skeleton" i], [aria-busy="true"]');
    for (const indicator of indicators) {
      const style = window.getComputedStyle(indicator);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = indicator.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return true;
    }
    return false;
  }).catch(() => false);
}

async function locateTotalText(page, timeoutMs) {
  const budget = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 5000;
  const deadline = Date.now() + budget;
  const remaining = () => Math.max(deadline - Date.now(), 250);
  const direct = await page.evaluate(() => {
    const root = document.body || document.documentElement;
    if (!root) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const value = node.nodeValue || '';
      if (/total\s+to\s+pay/i.test(value)) {
        const labelElement = node.parentElement;
        if (labelElement) {
          let row = labelElement.parentElement;
          let depth = 0;
          while (row && depth < 6) {
            const rowText = row.textContent || '';
            if (/(EUR|€)/i.test(rowText) && rowText !== (labelElement.textContent || '') && row.childElementCount > 0) {
              const valueElement = row.querySelector('[class*="value" i], [class*="amount" i], [class*="price" i]');
              if (valueElement) {
                return valueElement.textContent || rowText;
              }
              return rowText;
            }
            row = row.parentElement;
            depth = depth + 1;
          }
        }
      }
      node = walker.nextNode();
    }
    return null;
  }).catch(() => null);
  if (direct) {
    return direct;
  }
  const label = page.getByText(/total to pay/i).first();
  if ((await label.count().catch(() => 0)) > 0) {
    const siblingValue = label.locator('xpath=./following::*[contains(@class,"bx-order-summary__value")][1]').first();
    if ((await siblingValue.count().catch(() => 0)) > 0) {
      const text = await siblingValue.textContent({ timeout: remaining() }).catch(() => null);
      if (text) {
        return text;
      }
    }
    const row = label.locator('xpath=./ancestor::div[1]').first();
    if ((await row.count().catch(() => 0)) > 0) {
      const rowText = await row.textContent({ timeout: remaining() }).catch(() => null);
      if (rowText) {
        return rowText;
      }
    }
  }
  const values = await page.locator('.bx-order-summary__value').all().catch(() => []);
  for (let i = values.length - 1; i >= 0; i--) {
    const text = await values[i].textContent({ timeout: remaining() }).catch(() => null);
    if (!text || !/(EUR|€)/i.test(text)) {
      continue;
    }
    const labelled = await values[i].evaluate(el => {
      let node = el.parentElement;
      let depth = 0;
      while (node && depth < 4) {
        const className = typeof node.className === 'string' ? node.className : '';
        const nodeText = node.textContent || '';
        if (/total/i.test(className) || /total\s+to\s+pay/i.test(nodeText)) {
          return true;
        }
        node = node.parentElement;
        depth = depth + 1;
      }
      return false;
    }).catch(() => false);
    if (labelled) {
      return text;
    }
  }
  return null;
}

async function readTotalToPay(page, timeoutMs) {
  const budget = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 60000;
  const deadline = Date.now() + budget;
  await sleep(2500);
  let previous = null;
  let stableCount = 0;
  let loadingSince = null;
  while (Date.now() < deadline) {
    const loading = await isQuoteLoading(page);
    if (loading) {
      if (loadingSince === null) {
        loadingSince = Date.now();
      }
      if (Date.now() - loadingSince < 30000) {
        await sleep(2000);
        continue;
      }
    } else {
      loadingSince = null;
    }
    const remaining = Math.max(deadline - Date.now(), 250);
    const text = await locateTotalText(page, Math.min(remaining, 3000));
    const amount = text ? extractTotalEur(text) : NaN;
    if (text && /(EUR|€)/i.test(text) && Number.isFinite(amount) && amount > 0) {
      if (previous !== null && Math.abs(previous - amount) < 0.005) {
        stableCount = stableCount + 1;
        if (stableCount >= 3) {
          return amount;
        }
      } else {
        previous = amount;
        stableCount = 1;
      }
    } else {
      previous = null;
      stableCount = 0;
    }
    await sleep(2000);
  }
  throw new Error('total to pay not found');
}

async function clickCreateOrder(page) {
  const candidates = [
    page.locator('.bx-button--primary', { hasText: 'Create Order' }).first(),
    page.getByRole('button', { name: 'Create Order' }).first(),
    page.locator('button', { hasText: 'Create Order' }).first()
  ];
  for (const candidate of candidates) {
    try {
      await candidate.waitFor({ state: 'visible', timeout: 10000 });
      await candidate.click({ timeout: 10000 });
      return;
    } catch (err) {}
  }
  throw new Error('create order button not found');
}

async function getFlowSignature(page) {
  const value = await page.evaluate(() => {
    const fields = Array.from(document.querySelectorAll('input, textarea, select')).filter(el => {
      if (el.disabled) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const text = document.body ? (document.body.innerText || document.body.textContent || '') : '';
    return window.location.href + '|' + fields.length + '|' + fields.map(field => field.value || '').join('\u0001') + '|' + text.length;
  }).catch(() => null);
  return value;
}

async function waitForFlowChange(page, before, timeoutMs) {
  if (before === null) {
    return true;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const after = await getFlowSignature(page);
    if (after !== null && after !== before) {
      return true;
    }
    await sleep(1000);
  }
  return false;
}

async function clickPrimaryAction(page, preferredWords) {
  const preferred = Array.isArray(preferredWords) && preferredWords.length
    ? new RegExp('\\b(?:' + preferredWords.map(word => escapeRegExp(normalizeText(word))).join('|') + ')\\b', 'i')
    : null;
  for (const selector of PRIMARY_SCOPED_SELECTORS) {
    const buttons = await page.locator(selector).all().catch(() => []);
    for (const candidate of buttons) {
      if (!(await candidate.isEnabled().catch(() => false))) continue;
      if (!(await candidate.isVisible().catch(() => false))) continue;
      const text = normalizeText(await candidate.textContent().catch(() => ''));
      if (!text) continue;
      if (PRIMARY_STALE_PATTERN.test(text)) continue;
      if (preferred) {
        if (!preferred.test(text)) continue;
      } else if (!PRIMARY_ACTION_PATTERN.test(text)) {
        continue;
      }
      try {
        await candidate.click({ timeout: 6000 });
        return;
      } catch (err) {}
    }
  }
  const primaryButtons = await page.locator('button.bx-button--primary:visible, button[class*="primary" i]:visible').all().catch(() => []);
  for (const candidate of primaryButtons) {
    if (!(await candidate.isEnabled().catch(() => false))) continue;
    const text = normalizeText(await candidate.textContent().catch(() => ''));
    if (text && PRIMARY_STALE_PATTERN.test(text)) continue;
    if (preferred) {
      if (!text || !preferred.test(text)) continue;
    } else if (text && !PRIMARY_ACTION_PATTERN.test(text)) {
      continue;
    }
    try {
      await candidate.click({ timeout: 6000 });
      return;
    } catch (err) {}
  }
  const submitButtons = await page.locator('button[type="submit"]:visible').all().catch(() => []);
  for (const candidate of submitButtons) {
    if (!(await candidate.isEnabled().catch(() => false))) continue;
    const text = normalizeText(await candidate.textContent().catch(() => ''));
    if (text && PRIMARY_STALE_PATTERN.test(text)) continue;
    if (preferred && (!text || !preferred.test(text))) continue;
    try {
      await candidate.click({ timeout: 6000 });
      return;
    } catch (err) {}
  }
  const allButtons = await page.locator('button:visible, [role="button"]:visible').all().catch(() => []);
  for (const candidate of allButtons) {
    if (!(await candidate.isEnabled().catch(() => false))) continue;
    const text = normalizeText(await candidate.textContent().catch(() => ''));
    if (!text) continue;
    if (PRIMARY_STALE_PATTERN.test(text)) continue;
    if (preferred) {
      if (!preferred.test(text)) continue;
    } else if (!PRIMARY_ACTION_PATTERN.test(text)) {
      continue;
    }
    try {
      await candidate.click({ timeout: 6000 });
      return;
    } catch (err) {}
  }
  console.log('[flow] no primary action button found, pressing Enter');
  const signature = await getFlowSignature(page);
  await page.keyboard.press('Enter').catch(() => {});
  const changed = await waitForFlowChange(page, signature, 8000);
  if (!changed) {
    throw new Error('primary action via Enter produced no change');
  }
}

async function findEmailInput(page) {
  const strategies = [
    page.locator('input[type="email"]'),
    page.getByPlaceholder(/e-?mail/i),
    page.getByLabel(/e-?mail/i),
    page.locator('input[name*="email" i]')
  ];
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    for (const strategy of strategies) {
      const elements = await strategy.all().catch(() => []);
      for (const element of elements) {
        if (!(await element.isVisible().catch(() => false))) continue;
        if (!(await element.isEnabled().catch(() => false))) continue;
        if (await isReadOnlyInput(element)) continue;
        return element;
      }
    }
    await sleep(1000);
  }
  throw new Error('email input not found');
}

async function submitEmail(page, address) {
  const input = await findEmailInput(page);
  await input.fill(address);
  await sleep(500);
  await clickPrimaryAction(page, ['continue', 'confirm', 'submit', 'next', 'proceed']);
}

async function getAttributeText(locator, name) {
  const value = await locator.getAttribute(name).catch(() => null);
  return value === null || value === undefined ? '' : String(value);
}

async function isReadOnlyInput(input) {
  return await input.evaluate(el => el.readOnly === true || el.hasAttribute('readonly')).catch(() => false);
}

async function matchesCodeInputNegative(input) {
  const combined = (await getAttributeText(input, 'name')) + ' ' +
    (await getAttributeText(input, 'id')) + ' ' +
    (await getAttributeText(input, 'placeholder')) + ' ' +
    (await getAttributeText(input, 'aria-label')) + ' ' +
    (await getAttributeText(input, 'autocomplete'));
  return CODE_INPUT_NEGATIVE_PATTERN.test(combined);
}

async function isInsideVerificationContext(input) {
  return await input.evaluate(el => {
    let node = el.parentElement;
    let depth = 0;
    while (node && depth < 6) {
      const text = node.textContent || '';
      if (/(verification|verify|one[ -]?time|passcode|security code|enter the code)/i.test(text)) {
        return true;
      }
      node = node.parentElement;
      depth = depth + 1;
    }
    return false;
  }).catch(() => false);
}

async function findGroupedCharBoxes(page) {
  const info = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input[maxlength="1"]'));
    const visible = inputs.filter(input => {
      if (input.disabled || input.readOnly) return false;
      const style = window.getComputedStyle(input);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = input.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (visible.length < 4) return null;
    let container = visible[0].parentElement;
    while (container && container !== document.body && container !== document.documentElement) {
      if (visible.every(input => container.contains(input))) {
        const text = container.textContent || '';
        if (/(code|verification|verify|otp|passcode)/i.test(text)) {
          return { count: visible.length };
        }
        return null;
      }
      container = container.parentElement;
    }
    return null;
  }).catch(() => null);
  if (!info) {
    return [];
  }
  const elements = await page.locator('input[maxlength="1"]:visible').all().catch(() => []);
  return elements.slice(0, info.count);
}

async function findCodeInput(page, timeoutMs) {
  const totalTimeout = timeoutMs || 90000;
  const startedAt = Date.now();
  const deadline = startedAt + totalTimeout;
  const contextGraceMs = Math.min(totalTimeout, 20000);
  const emptyFallbackAllowed = totalTimeout >= 10000;
  while (Date.now() < deadline) {
    const elapsed = Date.now() - startedAt;
    const requireContext = elapsed < contextGraceMs;
    const grouped = await findGroupedCharBoxes(page);
    if (grouped.length >= 4) {
      const usable = [];
      for (const box of grouped) {
        if (!(await box.isEnabled().catch(() => false))) continue;
        if (await isReadOnlyInput(box)) continue;
        usable.push(box);
      }
      if (usable.length >= 4) {
        return { mode: 'chars', locators: usable, expectedLength: usable.length };
      }
    }
    const specificInputs = await page.locator('input[name*="code" i], input[id*="code" i], input[placeholder*="code" i], input[autocomplete="one-time-code"]').all().catch(() => []);
    for (const input of specificInputs) {
      if (!(await input.isVisible().catch(() => false))) continue;
      if (!(await input.isEnabled().catch(() => false))) continue;
      if (await isReadOnlyInput(input)) continue;
      if (await matchesCodeInputNegative(input)) continue;
      if (requireContext && !(await isInsideVerificationContext(input))) continue;
      const maxLength = await input.getAttribute('maxlength').catch(() => null);
      const parsedMaxLength = maxLength ? parseInt(maxLength, 10) : null;
      return {
        mode: 'single',
        locator: input,
        expectedLength: Number.isFinite(parsedMaxLength) && parsedMaxLength > 0 && parsedMaxLength <= 8 ? parsedMaxLength : null
      };
    }
    const textInputs = await page.locator('input[type="text"]:visible, input[type="number"]:visible, input[type="tel"]:visible, input:not([type]):visible').all().catch(() => []);
    const emptyInputs = [];
    for (const input of textInputs) {
      if (!(await input.isEnabled().catch(() => false))) continue;
      if (await isReadOnlyInput(input)) continue;
      if (await matchesCodeInputNegative(input)) continue;
      const maxLength = await input.getAttribute('maxlength').catch(() => null);
      const value = await input.inputValue().catch(() => '');
      if (maxLength === '1') continue;
      if (value) continue;
      emptyInputs.push(input);
    }
    if (emptyFallbackAllowed && Date.now() - startedAt >= 10000 && emptyInputs.length > 0) {
      for (const input of emptyInputs) {
        if (!(await isInsideVerificationContext(input))) continue;
        const maxLength = await input.getAttribute('maxlength').catch(() => null);
        const parsedMaxLength = maxLength ? parseInt(maxLength, 10) : null;
        return {
          mode: 'single',
          locator: input,
          expectedLength: Number.isFinite(parsedMaxLength) && parsedMaxLength > 0 && parsedMaxLength <= 8 ? parsedMaxLength : null
        };
      }
    }
    await sleep(1000);
  }
  throw new Error('verification code input not found');
}

async function fillVerificationCode(page, code, target) {
  const resolved = target || await findCodeInput(page, 30000);
  if (resolved.mode === 'chars') {
    if (code.length !== resolved.locators.length) {
      throw new Error('verification code length mismatch: ' + code.length + ' digits for ' + resolved.locators.length + ' inputs');
    }
    for (let i = 0; i < code.length; i++) {
      await resolved.locators[i].fill(code.charAt(i));
    }
  } else {
    const maxLength = await resolved.locator.getAttribute('maxlength').catch(() => null);
    const parsedMaxLength = maxLength ? parseInt(maxLength, 10) : null;
    if (parsedMaxLength && code.length > parsedMaxLength) {
      throw new Error('verification code length mismatch: ' + code.length + ' digits for input maxlength ' + parsedMaxLength);
    }
    await resolved.locator.click();
    await resolved.locator.fill(code);
  }
}

async function submitVerificationCode(page, code, target) {
  let resolved = target;
  try {
    await fillVerificationCode(page, code, resolved);
  } catch (err) {
    resolved = await findCodeInput(page, 30000);
    await fillVerificationCode(page, code, resolved);
  }
  await sleep(1500);
  let stillVisible = false;
  try {
    stillVisible = resolved.mode === 'chars' ? await resolved.locators[0].isVisible() : await resolved.locator.isVisible();
  } catch (err) {
    stillVisible = false;
  }
  if (stillVisible) {
    await clickPrimaryAction(page, ['verify', 'confirm', 'submit', 'continue', 'next']);
  }
}

async function fillTextInput(page, selector, value) {
  const input = page.locator(selector).first();
  await input.waitFor({ state: 'visible', timeout: 30000 });
  await input.click();
  await input.fill(value);
  const current = await input.inputValue();
  if (current === value) return;
  await input.fill('');
  await input.pressSequentially(value, { delay: 50 });
  const typed = await input.inputValue();
  if (typed !== value) {
    throw new Error('could not fill ' + selector);
  }
}

function toIsoDob(dob) {
  const parts = String(dob).match(/^([0-9]{2})-([0-9]{2})-([0-9]{4})$/);
  if (!parts) return null;
  return parts[3] + '-' + parts[1] + '-' + parts[2];
}

function dobComponentsMatch(value) {
  const raw = String(value === null || value === undefined ? '' : value).trim();
  if (!raw) return false;
  const isoMatch = raw.match(/^([0-9]{4})[-/.]([0-9]{2})[-/.]([0-9]{2})/);
  const dmyMatch = raw.match(/^([0-9]{2})[-/.]([0-9]{2})[-/.]([0-9]{4})/);
  let year = null;
  let month = null;
  let day = null;
  if (isoMatch) {
    year = isoMatch[1];
    month = isoMatch[2];
    day = isoMatch[3];
  } else if (dmyMatch) {
    day = dmyMatch[1];
    month = dmyMatch[2];
    year = dmyMatch[3];
  } else {
    const digits = digitsOnly(raw);
    if (digits.length !== 8) return false;
    if (/^(19|20)/.test(digits)) {
      year = digits.slice(0, 4);
      month = digits.slice(4, 6);
      day = digits.slice(6, 8);
    } else {
      day = digits.slice(0, 2);
      month = digits.slice(2, 4);
      year = digits.slice(4, 8);
    }
  }
  const expected = toIsoDob(DATE_OF_BIRTH);
  if (!expected) return false;
  return year + '-' + month + '-' + day === expected;
}

async function fillDateOfBirth(page) {
  const input = page.locator('#dob').first();
  await input.waitFor({ state: 'visible', timeout: 30000 });
  const inputType = await input.getAttribute('type');
  const isoValue = toIsoDob(DATE_OF_BIRTH);
  if (inputType === 'date' && isoValue) {
    await input.fill(isoValue);
    if (dobComponentsMatch(await input.inputValue().catch(() => ''))) {
      return;
    }
  }
  await input.click();
  await input.fill(DATE_OF_BIRTH);
  if (dobComponentsMatch(await input.inputValue().catch(() => ''))) {
    return;
  }
  await input.fill('');
  await input.pressSequentially(DATE_OF_BIRTH, { delay: 60 });
  if (dobComponentsMatch(await input.inputValue().catch(() => ''))) {
    return;
  }
  await input.fill('');
  await input.pressSequentially(digitsOnly(DATE_OF_BIRTH), { delay: 60 });
  if (dobComponentsMatch(await input.inputValue().catch(() => ''))) {
    return;
  }
  throw new Error('could not fill date of birth');
}

async function waitForOptionalLocator(page, selector, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const locator = page.locator(selector).first();
    if ((await locator.count().catch(() => 0)) > 0 && (await locator.isVisible().catch(() => false))) {
      return locator;
    }
    await sleep(1000);
  }
  return null;
}

async function waitForOptionalText(page, pattern, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const locator = page.getByText(pattern).first();
    if ((await locator.count().catch(() => 0)) > 0 && (await locator.isVisible().catch(() => false))) {
      return locator;
    }
    await sleep(1000);
  }
  return null;
}

async function submitTaxDetails(page) {
  const taxCountry = await waitForOptionalText(page, /tax country/i, 20000);
  if (!taxCountry) {
    return;
  }
  await selectFromLabeledControl(page, 'Tax Country', TAX_COUNTRY);
  const hasTaxId = await waitForOptionalLocator(page, '#taxId', 15000);
  if (hasTaxId) {
    await fillTextInput(page, '#taxId', TAX_ID);
  }
  const hasDob = await waitForOptionalLocator(page, '#dob', 15000);
  if (hasDob) {
    await fillDateOfBirth(page);
  }
  await sleep(500);
  await clickPrimaryAction(page, ['confirm', 'continue', 'submit', 'next', 'proceed']);
}

async function scrollToTop(page) {
  let scrollY = null;
  try {
    scrollY = await page.evaluate(async () => {
      const roots = [document.documentElement, document.body];
      for (const root of roots) {
        if (root && root.style) {
          root.style.scrollBehavior = 'auto';
        }
      }
      window.scrollTo(0, 0);
      for (const root of roots) {
        if (root) root.scrollTop = 0;
      }
      await new Promise(resolve => setTimeout(resolve, 300));
      return window.scrollY || 0;
    });
  } catch (err) {
    scrollY = null;
  }
  if (scrollY !== null && scrollY > 4) {
    await sleep(500);
    try {
      scrollY = await page.evaluate(async () => {
        window.scrollTo(0, 0);
        await new Promise(resolve => setTimeout(resolve, 300));
        return window.scrollY || 0;
      });
    } catch (err) {
      scrollY = null;
    }
  }
  if (scrollY !== null && scrollY > 4) {
    throw new Error('could not scroll to top, scrollY ' + scrollY);
  }
  await sleep(300);
}

async function measureButtonRect(page, buttonLocator) {
  if (!(await canReceivePointerEvents(buttonLocator))) {
    throw new Error('apple pay button not actionable');
  }
  const box = await buttonLocator.boundingBox();
  if (!box) {
    throw new Error('apple pay button not measurable');
  }
  const rect = {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height)
  };
  const viewportSize = await page.evaluate(() => ({
    width: Math.round(document.documentElement.clientWidth),
    height: Math.round(document.documentElement.clientHeight)
  })).catch(() => null);
  const limitWidth = viewportSize && viewportSize.width > 0 ? viewportSize.width : VIEWPORT.width;
  const limitHeight = viewportSize && viewportSize.height > 0 ? viewportSize.height : VIEWPORT.height;
  if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > limitWidth || rect.y + rect.height > limitHeight) {
    throw new Error('apple pay button outside visible viewport');
  }
  return rect;
}

async function measureViewport(page) {
  return await page.evaluate(() => ({
    width: Math.round(document.documentElement.clientWidth),
    docHeight: Math.round(document.documentElement.scrollHeight)
  }));
}

async function detectOrderOutcome(page, buttonLocator) {
  let bodyText = '';
  try {
    bodyText = await page.evaluate(() => (document.body && (document.body.innerText || document.body.textContent)) || '');
  } catch (err) {
    bodyText = '';
  }
  if (bodyText) {
    if (ORDER_PAID_PATTERN.test(bodyText)) {
      return 'paid';
    }
    if (ORDER_EXPIRED_PATTERN.test(bodyText)) {
      return 'expired';
    }
  }
  const visible = buttonLocator ? await buttonLocator.isVisible().catch(() => false) : false;
  return visible ? 'available' : 'unavailable';
}

async function buildIdentityMarkers(page) {
  const text = await page.evaluate(() => (document.body && (document.body.innerText || document.body.textContent)) || '').catch(() => '');
  const markers = [];
  const normalized = normalizeText(text);
  const walletMarker = normalizeText(WALLET);
  if (walletMarker && normalized.indexOf(walletMarker) !== -1) {
    markers.push(walletMarker);
  }
  [COIN, BLOCKCHAIN, PAYMENT_METHOD].forEach(label => {
    const marker = normalizeText(label);
    if (marker && normalized.indexOf(marker) !== -1) {
      markers.push(marker);
    }
  });
  return markers;
}

async function verifyInCleanContext(url, button, totalEur, identityMarkers) {
  const context = await createAutomationContext();
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    const buttonLocator = await waitForApplePayButton(page, 60000);
    await scrollToTop(page);
    const cleanButton = await measureButtonRect(page, buttonLocator);
    const geometryMatches = Math.abs(cleanButton.x - button.x) <= CLEAN_CONTEXT_TOLERANCE &&
      Math.abs(cleanButton.y - button.y) <= CLEAN_CONTEXT_TOLERANCE &&
      Math.abs(cleanButton.width - button.width) <= CLEAN_CONTEXT_TOLERANCE &&
      Math.abs(cleanButton.height - button.height) <= CLEAN_CONTEXT_TOLERANCE;
    if (!geometryMatches) {
      return false;
    }
    const cleanText = await page.evaluate(() => (document.body && (document.body.innerText || document.body.textContent)) || '').catch(() => '');
    const normalizedClean = normalizeText(cleanText);
    for (const marker of (identityMarkers || [])) {
      if (normalizedClean.indexOf(marker) === -1) {
        return false;
      }
    }
    const totalText = await locateTotalText(page, 4000).catch(() => null);
    if (totalText) {
      const cleanTotal = extractTotalEur(totalText);
      if (Number.isFinite(cleanTotal) && Number.isFinite(totalEur) && Math.abs(cleanTotal - totalEur) > 0.01) {
        return false;
      }
    }
    return true;
  } catch (err) {
    return false;
  } finally {
    await closeContextSafely(context);
  }
}

function runWithTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(message));
    }, timeoutMs);
    promise.then(value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }, err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

function ensureWithinDeadline(deadline, stage) {
  if (deadline && Date.now() > deadline) {
    throw new Error('session creation deadline exceeded at ' + stage);
  }
}

function generateSessionId(prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + randomString(8, 'abcdefghijklmnopqrstuvwxyz0123456789');
}

async function createSessionInternal(agent, deadline) {
  const mailbox = await createMailbox();
  const context = await createAutomationContext();
  try {
    const page = await context.newPage();
    await page.goto(BANXA_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
    await sleep(1500);
    ensureWithinDeadline(deadline, 'initial load');
    await dismissConsentIfPresent(page);
    await fillFiatAmount(page, agent.amount);
    await selectFiatCurrency(page, FIAT_CURRENCY);
    await ensureFiatAmount(page, agent.amount);
    ensureWithinDeadline(deadline, 'fiat selection');
    await selectCoin(page, COIN);
    await ensureFiatAmount(page, agent.amount);
    ensureWithinDeadline(deadline, 'coin selection');
    await selectFromLabeledControl(page, 'Selected blockchain', BLOCKCHAIN);
    await ensureFiatAmount(page, agent.amount);
    ensureWithinDeadline(deadline, 'blockchain selection');
    await dismissConsentIfPresent(page);
    await fillWalletAddress(page, WALLET);
    ensureWithinDeadline(deadline, 'wallet entry');
    await selectFromLabeledControl(page, 'Payment method', PAYMENT_METHOD);
    await ensureFiatAmount(page, agent.amount);
    await verifyOrderFormDetails(page, agent);
    ensureWithinDeadline(deadline, 'order form verification');
    const totalEur = await readTotalToPay(page);
    ensureWithinDeadline(deadline, 'total read');
    await clickCreateOrder(page);
    await submitEmail(page, mailbox.address);
    ensureWithinDeadline(deadline, 'email submission');
    const codeInput = await findCodeInput(page, 90000);
    const verification = await waitForVerificationCode(mailbox, new Set(), 5 * 60 * 1000, codeInput ? codeInput.expectedLength : null);
    await submitVerificationCode(page, verification.code, codeInput);
    ensureWithinDeadline(deadline, 'verification');
    await submitTaxDetails(page);
    ensureWithinDeadline(deadline, 'tax details');
    const buttonLocator = await waitForApplePayButton(page, 120000);
    const outcome = await detectOrderOutcome(page, buttonLocator);
    if (outcome !== 'available') {
      throw new Error('order not payable before publication: ' + outcome);
    }
    await scrollToTop(page);
    const button = await measureButtonRect(page, buttonLocator);
    const viewport = await measureViewport(page);
    const url = page.url();
    const identityMarkers = await buildIdentityMarkers(page);
    let finalTotalEur = totalEur;
    try {
      const reread = await readTotalToPay(page, 12000);
      if (Number.isFinite(reread) && reread > 0) {
        finalTotalEur = reread;
      }
    } catch (err) {}
    ensureWithinDeadline(deadline, 'payment readiness');
    const verified = await verifyInCleanContext(url, button, finalTotalEur, identityMarkers);
    if (!verified) {
      throw new Error('clean context verification failed for ' + agent.key);
    }
    return {
      context: context,
      page: page,
      url: url,
      totalEur: finalTotalEur,
      button: button,
      viewport: viewport,
      mailbox: mailbox,
      sessionId: generateSessionId(agent.key),
      processedIds: verification.ids
    };
  } catch (err) {
    await deleteMailbox(mailbox);
    await closeContextSafely(context);
    throw err;
  }
}

async function createSession(agent) {
  let delivered = false;
  const deadline = Date.now() + SESSION_CREATION_TIMEOUT;
  const internal = createSessionInternal(agent, deadline);
  internal.then(result => {
    setTimeout(() => {
      if (!delivered) {
        deleteMailbox(result.mailbox);
        closeContextSafely(result.context);
      }
    }, 500);
  }, () => {});
  const session = await runWithTimeout(internal, SESSION_CREATION_TIMEOUT, 'session creation timed out for ' + agent.key);
  delivered = true;
  return session;
}

function scheduleRotation(agent, delay) {
  clearTimeout(agent.rotationTimer);
  agent.rotationTimer = setTimeout(() => {
    startCycle(agent).catch(() => {});
  }, delay);
}

async function startCycle(agent) {
  if (agent.cycleActive) return;
  agent.cycleActive = true;
  try {
    const session = await createSession(agent);
    agent.failures = 0;
    await publishSession(agent, session);
    scheduleRotation(agent, ROTATION_INTERVAL);
  } catch (err) {
    agent.failures = agent.failures + 1;
    const backoff = Math.min(RETRY_DELAY * agent.failures, MAX_RETRY_DELAY);
    console.error('[' + agent.key + '] session creation failed (attempt ' + agent.failures + '): ' + ((err && err.message) || String(err)));
    scheduleRotation(agent, backoff);
  } finally {
    agent.cycleActive = false;
  }
}

async function stopKeeper(agent) {
  if (agent.keeperTimer) {
    clearInterval(agent.keeperTimer);
    agent.keeperTimer = null;
  }
  agent.keeperBusy = false;
  agent.keeperBusySince = null;
  agent.keeperBusyToken = null;
  agent.consumedQueued = false;
  const live = agent.live;
  agent.live = null;
  if (live) {
    await deleteMailbox(live.mailbox);
    if (live.context) {
      const closed = await closeContextSafely(live.context);
      if (!closed) {
        console.error('[' + agent.key + '] failed to close live context');
      }
    }
  }
}

function startKeeper(agent) {
  agent.keeperTimer = setInterval(() => {
    if (agent.keeperBusy && agent.keeperBusySince && Date.now() - agent.keeperBusySince > KEEPER_BUSY_RESET_MS) {
      agent.keeperBusy = false;
      agent.keeperBusySince = null;
      agent.keeperBusyToken = null;
    }
    const published = state[agent.key];
    if (published && published.reserved && published.reservedAt && Date.now() - published.reservedAt > RESERVATION_TTL) {
      published.reserved = false;
      published.reservedAt = null;
      console.log('[' + agent.key + '] reservation expired');
    }
    runLiveCheck(agent, 0, false, false);
  }, KEEPALIVE_INTERVAL);
}

async function publishSession(agent, session) {
  await stopKeeper(agent);
  agent.live = session;
  state[agent.key] = {
    status: 'live',
    sessionId: session.sessionId,
    url: session.url,
    totalEur: session.totalEur,
    button: session.button,
    viewport: session.viewport,
    publishedAt: Date.now(),
    reserved: false,
    reservedAt: null
  };
  console.log('[' + agent.key + '] published live session ' + session.sessionId + ', total ' + session.totalEur + ' EUR');
  startKeeper(agent);
}

function setKeeperBusy(agent, busy, token) {
  agent.keeperBusy = busy;
  agent.keeperBusySince = busy ? Date.now() : null;
  agent.keeperBusyToken = busy ? token : null;
}

function runLiveCheck(agent, settleDelayMs, isConsumption, isRetry) {
  if (!agent.live) {
    return 'no-live';
  }
  if (agent.keeperBusy) {
    if (isConsumption && settleDelayMs > 0) {
      agent.consumedQueued = true;
      return 'queued';
    }
    return 'busy';
  }
  const token = {};
  setKeeperBusy(agent, true, token);
  verifyLiveWithRetry(agent, settleDelayMs, isConsumption).then(() => {
    if (agent.keeperBusyToken !== token) {
      return;
    }
    setKeeperBusy(agent, false);
    const queued = agent.consumedQueued;
    agent.consumedQueued = false;
    if (queued && agent.live) {
      runLiveCheck(agent, CONSUMED_SETTLE_DELAY, true, true);
    }
  }, err => {
    if (agent.keeperBusyToken !== token) {
      return;
    }
    setKeeperBusy(agent, false);
    agent.consumedQueued = false;
    console.error('[' + agent.key + '] live check failed unexpectedly: ' + ((err && err.message) || String(err)));
    if (isConsumption && !isRetry && agent.live) {
      setTimeout(() => {
        if (agent.live) {
          runLiveCheck(agent, KEEPER_RETRY_DELAY, true, true);
        }
      }, 2 * KEEPER_RETRY_DELAY);
    }
  });
  return 'started';
}

function verifyConsumed(agent, sessionId) {
  const published = state[agent.key];
  if (!published || published.status !== 'live' || !agent.live) {
    return { outcome: 'ignored', matched: false };
  }
  if (sessionId && published.sessionId && sessionId !== published.sessionId) {
    return { outcome: 'ignored', matched: false };
  }
  const checkStatus = runLiveCheck(agent, CONSUMED_SETTLE_DELAY, true, false);
  if (checkStatus === 'queued' || checkStatus === 'busy') {
    return { outcome: 'queued', matched: true };
  }
  if (checkStatus === 'started') {
    return { outcome: 'processing', matched: true };
  }
  return { outcome: 'ignored', matched: false };
}

async function verifyLiveWithRetry(agent, settleDelayMs, isConsumption) {
  const live = agent.live;
  if (!live) return;
  let remainingDelay = settleDelayMs;
  let succeeded = false;
  let outcome = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (agent.live !== live) return;
    try {
      outcome = await reloadAndMeasureLive(agent, live, remainingDelay, isConsumption);
      succeeded = true;
      break;
    } catch (err) {
      if (agent.live !== live) return;
      if (attempt === 0) {
        await sleep(KEEPER_RETRY_DELAY);
      }
    }
    remainingDelay = 0;
  }
  if (agent.live !== live) return;
  if (isConsumption) {
    await degradeSession(agent, live);
    return;
  }
  if (!succeeded || outcome !== 'available') {
    await degradeSession(agent, live);
  }
}

async function reloadAndMeasureLive(agent, live, settleDelayMs, isConsumption) {
  if (settleDelayMs > 0) {
    await sleep(settleDelayMs);
  }
  if (agent.live !== live) return null;
  await live.page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await handleRepromptIfPresent(live);
  let outcome = await detectOrderOutcome(live.page, null);
  if (outcome === 'paid' || outcome === 'expired') {
    return outcome;
  }
  const buttonLocator = await waitForApplePayButton(live.page, 30000);
  outcome = await detectOrderOutcome(live.page, buttonLocator);
  if (isConsumption && outcome === 'available') {
    const reconcileDeadline = Date.now() + CONSUMED_RECONCILE_TIMEOUT;
    while (Date.now() < reconcileDeadline) {
      await sleep(5000);
      if (agent.live !== live) return null;
      const refreshed = await detectOrderOutcome(live.page, null);
      if (refreshed === 'paid' || refreshed === 'expired') {
        return refreshed;
      }
      const stillVisible = await buttonLocator.isVisible().catch(() => false);
      if (!stillVisible) {
        return 'unavailable';
      }
    }
  }
  await scrollToTop(live.page);
  const button = await measureButtonRect(live.page, buttonLocator);
  const viewport = await measureViewport(live.page);
  const url = live.page.url();
  live.url = url;
  live.button = button;
  live.viewport = viewport;
  if (agent.live === live && state[agent.key] && state[agent.key].status === 'live') {
    state[agent.key] = Object.assign({}, state[agent.key], { url: url, button: button, viewport: viewport });
  }
  return outcome;
}

async function handleRepromptIfPresent(live) {
  await sleep(1000);
  let codeTarget = null;
  try {
    codeTarget = await findCodeInput(live.page, 3000);
  } catch (err) {
    codeTarget = null;
  }
  if (!codeTarget) return;
  if (!live.mailbox || !live.mailbox.token) {
    throw new Error('verification prompt after reload without mailbox');
  }
  const verification = await waitForVerificationCode(live.mailbox, live.processedIds, REPROMPT_CODE_TIMEOUT, codeTarget.expectedLength);
  live.processedIds = verification.ids;
  await submitVerificationCode(live.page, verification.code, codeTarget);
}

async function degradeSession(agent, live) {
  if (agent.live !== live) return;
  state[agent.key] = emptyPublicSession();
  await stopKeeper(agent);
  startCycle(agent).catch(() => {});
}

const app = express();

app.use(express.json());

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/state', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(state);
});

app.post('/api/reserve/:product', (req, res) => {
  const product = req.params.product;
  if (!Object.prototype.hasOwnProperty.call(agents, product)) {
    res.status(404).json({ error: 'unknown product' });
    return;
  }
  const published = state[product];
  if (!published || published.status !== 'live') {
    res.status(409).json({ error: 'no live session', reserved: false });
    return;
  }
  if (published.reserved) {
    res.status(409).json({ error: 'session already reserved', reserved: true, sessionId: published.sessionId });
    return;
  }
  published.reserved = true;
  published.reservedAt = Date.now();
  res.set('Cache-Control', 'no-store');
  res.json(Object.assign({}, published, { reserved: true }));
});

app.post('/api/release/:product', (req, res) => {
  const product = req.params.product;
  if (!Object.prototype.hasOwnProperty.call(agents, product)) {
    res.status(404).json({ error: 'unknown product' });
    return;
  }
  const published = state[product];
  if (published && published.status === 'live') {
    published.reserved = false;
    published.reservedAt = null;
  }
  res.set('Cache-Control', 'no-store');
  res.json({ released: true });
});

app.post('/api/consumed/:product', (req, res) => {
  const product = req.params.product;
  if (!Object.prototype.hasOwnProperty.call(agents, product)) {
    res.status(404).json({ error: 'unknown product' });
    return;
  }
  const sessionId = (req.body && typeof req.body.sessionId === 'string' && req.body.sessionId) ||
    (typeof req.query.sessionId === 'string' && req.query.sessionId) || null;
  const result = verifyConsumed(agents[product], sessionId);
  res.set('Cache-Control', 'no-store');
  res.json({ accepted: result.matched, product: product, sessionId: sessionId, outcome: result.outcome, matched: result.matched });
});

const server = app.listen(PORT, () => {
  console.log('zsebibaba server listening on port ' + PORT);
  Object.keys(agents).forEach(key => {
    startCycle(agents[key]).catch(err => {
      console.error('[' + key + '] initial session creation failed: ' + ((err && err.message) || String(err)));
    });
  });
});

server.on('error', err => {
  console.error('server error: ' + ((err && err.message) || String(err)));
});

async function shutdown() {
  for (const key of Object.keys(agents)) {
    const agent = agents[key];
    clearTimeout(agent.rotationTimer);
    try {
      await stopKeeper(agent);
    } catch (err) {}
  }
  try {
    server.close();
  } catch (err) {}
  const promise = browserPromise;
  browserPromise = null;
  if (promise) {
    try {
      const browser = await promise;
      if (browser && typeof browser.close === 'function') {
        await browser.close();
      }
    } catch (err) {}
  }
  await sleep(1000);
  process.exit(0);
}

process.on('SIGINT', () => {
  shutdown();
});

process.on('SIGTERM', () => {
  shutdown();
});
