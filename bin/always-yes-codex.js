#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { spawn } from "node-pty";

const args = process.argv.slice(2);
const verbose = takeFlag(args, "--verbose");
const once = takeFlag(args, "--once");
let command = takeOption(args, "--command") ?? "codex";
const answer = takeOption(args, "--answer") ?? "yes";
const submitKeyName = takeOption(args, "--submit-key") ?? "cr";
const delayMs = Number(takeOption(args, "--delay-ms") ?? 250);
const submitDelayMs = Number(takeOption(args, "--submit-delay-ms") ?? 500);
const cooldownMs = Number(takeOption(args, "--cooldown-ms") ?? 4000);
const echoTest = takeFlag(args, "--echo-test");
const debugScreen = takeOption(args, "--debug-screen");
const submitKey = decodeSubmitKey(submitKeyName);

if (takeFlag(args, "--help")) {
  printHelp();
  process.exit(0);
}

if (takeFlag(args, "--self-test")) {
  runSelfTest();
  process.exit(0);
}

if (debugScreen !== undefined) {
  debugScreenText(debugScreen);
  process.exit(0);
}

if (echoTest) {
  runEchoTest();
}

const pty = spawn(resolveCommand(command), args, {
  name: "xterm-256color",
  cols: process.stdout.columns || 120,
  rows: process.stdout.rows || 30,
  cwd: process.cwd(),
  env: {
    ...process.env,
    TERM: process.env.TERM || "xterm-256color",
  },
});

let recent = "";
let lastAnswerAt = 0;
let answered = false;
let answerTimer = null;
let pendingPromptKey = null;
let pendingSubmitAnswer = null;
let submitTimer = null;
const answeredPromptKeys = new Set();
const stdinDecoder = new StringDecoder("utf8");

pty.onData((data) => {
  process.stdout.write(data);
  recent = tail(`${recent}${stripAnsi(data)}`, 8000);
  maybeAnswer();
});

pty.onExit(({ exitCode }) => {
  cleanup();
  process.exit(exitCode ?? 0);
});

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on("data", (data) => {
  const text = stdinDecoder.write(data);
  if (text.length > 0) {
    pty.write(text);
  }
});
process.stdin.on("end", () => {
  const text = stdinDecoder.end();
  if (text.length > 0) {
    pty.write(text);
  }
});

process.stdout.on("resize", () => {
  pty.resize(process.stdout.columns || 120, process.stdout.rows || 30);
});

process.on("SIGINT", () => {
  pty.write("\x03");
});

process.on("exit", cleanup);

function maybeAnswer() {
  if (answerTimer || (once && answered)) {
    return;
  }

  const text = normalize(recent);
  if (maybeSubmitTypedAnswer(text)) {
    return;
  }

  if (pendingSubmitAnswer !== null) {
    return;
  }

  const now = Date.now();
  if (now - lastAnswerAt < cooldownMs) {
    return;
  }

  const promptKey = autoAnswerPromptKey(text);
  if (promptKey !== null && !answeredPromptKeys.has(promptKey)) {
    pendingPromptKey = promptKey;
  }

  if (pendingPromptKey === null || !isInputPromptReady(text)) {
    return;
  }

  answerTimer = setTimeout(() => {
    answerTimer = null;
    const current = normalize(recent);
    if (pendingPromptKey === null || answeredPromptKeys.has(pendingPromptKey) || !isInputPromptReady(current)) {
      log("skip: prompt changed or became blocked");
      return;
    }
    lastAnswerAt = Date.now();
    answered = true;
    answeredPromptKeys.add(pendingPromptKey);
    trimAnsweredPromptKeys();
    const answeredKey = pendingPromptKey;
    pendingPromptKey = null;
    pendingSubmitAnswer = answer;
    if (currentInputPromptText(current) !== "") {
      pty.write("\x15");
    }
    setTimeout(() => {
      pty.write(answer);
      scheduleSubmitIfNeeded();
    }, 100);
    log(`typed: ${answer} key=${answeredKey.slice(0, 80)}`);
  }, Math.max(0, delayMs));
}

function maybeSubmitTypedAnswer(text) {
  if (pendingSubmitAnswer === null || submitTimer !== null) {
    return false;
  }

  if (currentInputPromptText(text) !== pendingSubmitAnswer) {
    return false;
  }

  submitTimer = setTimeout(() => {
    submitPendingAnswer();
  }, 50);
  return true;
}

function scheduleSubmitIfNeeded() {
  if (pendingSubmitAnswer === null || submitTimer !== null) {
    return;
  }
  submitTimer = setTimeout(() => {
    submitPendingAnswer();
  }, Math.max(0, submitDelayMs));
}

function submitPendingAnswer() {
  if (pendingSubmitAnswer === null) {
    submitTimer = null;
    return;
  }
  pty.write(submitKey);
  lastAnswerAt = Date.now();
  pendingSubmitAnswer = null;
  submitTimer = null;
  recent = "";
  log(`submitted: ${submitKeyName}`);
}

function looksLikeQuestion(text) {
  const promptTail = text.slice(-500);
  return /[?？](?:\s|[:：>»\]\)]|$)/.test(promptTail)
    || /\b\(y\/n\)|\[y\/n\]|\byes\/no\b/i.test(promptTail);
}

function shouldAutoAnswer(text) {
  return autoAnswerPromptKey(text) !== null;
}

function autoAnswerPromptKey(text) {
  if (isBlockedPrompt(text)) {
    return null;
  }

  const promptText = extractPromptText(text);
  if (promptText === null) {
    return null;
  }

  if ((looksLikeQuestion(promptText)
    && (looksLikeYesNoPrompt(promptText) || looksLikeLowRiskDirectionPrompt(promptText)))
    || looksLikeRecommendedChoicePrompt(promptText)) {
    return promptText.toLowerCase();
  }

  return null;
}

function isInputPromptReady(text) {
  const inputText = currentInputPromptText(text);
  return inputText !== null && (inputText.length === 0 || isCodexPlaceholder(inputText) || isCodexExamplePrompt(inputText));
}

function currentInputPromptText(text) {
  const lines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = lines[index].match(/^\s*›\s*(.*)$/u);
    if (match) {
      return match[1].trim();
    }
  }

  return null;
}

function isCodexPlaceholder(text) {
  const placeholders = [
    /^Run\s+\/\w+/i,
    /^Use\s+\/\w+/i,
    /^Find and fix a bug in @filename$/i,
    /^Write tests for @filename$/i,
    /^Add a feature to @filename$/i,
    /^Improve documentation in @filename$/i,
    /^Explain this codebase$/i,
    /^Ask\s+/i,
    /^Type\s+/i,
  ];
  return placeholders.some((pattern) => pattern.test(text));
}

function isCodexExamplePrompt(text) {
  return /@filename\b/i.test(text);
}

function extractPromptText(text) {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (/[?？]|\b\(y\/n\)|\[y\/n\]|\byes\/no\b/i.test(line)) {
      const parts = [];
      if (index > 0 && containsRecommendation(lines[index - 1])) {
        parts.push(lines[index - 1]);
      }
      parts.push(line);
      if (index + 1 < lines.length && containsRecommendation(lines[index + 1])) {
        parts.push(lines[index + 1]);
      }
      return normalize(parts.join(" ")).slice(-1000);
    }
  }

  const tailText = text.slice(-1000);
  if (looksLikeRecommendedChoicePrompt(tailText)) {
    return normalize(tailText);
  }

  return null;
}

function containsRecommendation(text) {
  return /\b(?:i recommend|my recommendation|recommended)\b/i.test(text)
    || /(?:我推荐|我建议|建议选|推荐选|推荐|建议)/.test(text);
}

function looksLikeYesNoPrompt(text) {
  const promptTail = text.slice(-500);
  const patterns = [
    /\b\(y\/n\)|\[y\/n\]|\byes\/no\b/i,
    /\b(?:do|does|did|is|are|was|were|can|could|should|shall|would|will|have|has|had|may|might|must)\b[^?]{0,240}\?/i,
    /(?:吗|么|是否|是不是|有没有|要不要|能不能|可不可以|需不需要|要我|我可以)[^？?]{0,160}[？?]/,
  ];
  return patterns.some((pattern) => pattern.test(promptTail));
}

function looksLikeLowRiskDirectionPrompt(text) {
  const patterns = [
    /\b(?:should|shall|can) i\b.{0,120}\b(?:continue|proceed|go ahead|use|take|follow|start|draft|make|create|implement)\b/i,
    /\bdo you want me to\b.{0,120}\b(?:continue|proceed|go ahead|use|take|follow|start|draft|make|create|implement)\b/i,
    /\bwould you like me to\b.{0,120}\b(?:continue|proceed|go ahead|use|take|follow|start|draft|make|create|implement)\b/i,
    /\bis (?:that|this) (?:ok|okay|acceptable|fine)\b/i,
    /\b(?:accept|use|follow) (?:this|that|the) (?:direction|approach|plan|recommendation)\b/i,
    /(?:要不要|是否|可以|可以吗|要我|我可以).{0,80}(?:继续|按|采用|接受|走|方向|方案|建议|计划|实现|创建|开始)/,
    /(?:这个|该|这套).{0,30}(?:方向|方案|建议|计划).{0,30}(?:可以|接受|同意|行吗|好吗)/,
  ];
  return patterns.some((pattern) => pattern.test(text));
}

function looksLikeRecommendedChoicePrompt(text) {
  const promptTail = text.slice(-1000);
  const patterns = [
    /\b(?:which|what)\b.{0,160}\b(?:option|approach|plan|direction|choice)\b.{0,240}\b(?:i recommend|my recommendation|recommended)\b/i,
    /\b(?:i recommend|my recommendation|recommended)\b.{0,240}\b(?:which|what)\b.{0,160}\b(?:option|approach|plan|direction|choice)\b/i,
    /(?:选哪个|哪个方案|哪种方案|哪个方向|哪种方向|哪个计划|哪种计划|怎么选).{0,240}(?:我推荐|我建议|建议选|推荐选|推荐|建议)/,
    /(?:我推荐|我建议|建议选|推荐选|推荐|建议).{0,240}(?:选哪个|哪个方案|哪种方案|哪个方向|哪种方向|哪个计划|哪种计划|怎么选)/,
  ];
  return patterns.some((pattern) => pattern.test(promptTail));
}

function isBlockedPrompt(text) {
  const blockers = [
    /\b(?:approval|approve|permission|authorize|allow)\b/i,
    /\b(?:sandbox|escalat(?:e|ed|ion)|require_escalated|outside the sandbox)\b/i,
    /\b(?:run|execute|launch)\b.{0,80}\b(?:command|shell|terminal|powershell|cmd|bash|script)\b/i,
    /\b(?:delete|remove|overwrite|erase|format|reset|checkout|revert|kill)\b/i,
    /\b(?:install|download|network|internet|registry|npm|pip|cargo|nuget|scp|ssh|sudo|administrator|admin)\b/i,
    /(?:授权|审批|批准|允许|权限|提权|沙箱|执行命令|运行命令|终端|命令行|删除|覆盖|重置|回滚|安装|下载|联网|网络|管理员|高风险|危险)/,
  ];
  return blockers.some((pattern) => pattern.test(text));
}

function stripAnsi(value) {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\r/g, "\n");
}

function normalize(value) {
  return value
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function tail(value, maxLength) {
  return value.length > maxLength ? value.slice(value.length - maxLength) : value;
}

function trimAnsweredPromptKeys() {
  while (answeredPromptKeys.size > 100) {
    const oldest = answeredPromptKeys.values().next().value;
    answeredPromptKeys.delete(oldest);
  }
}

function takeFlag(values, flag) {
  const index = values.indexOf(flag);
  if (index === -1) {
    return false;
  }
  values.splice(index, 1);
  return true;
}

function takeOption(values, option) {
  const index = values.indexOf(option);
  if (index === -1) {
    return undefined;
  }
  const value = values[index + 1];
  values.splice(index, value === undefined ? 1 : 2);
  return value;
}

function decodeSubmitKey(value) {
  switch (value.toLowerCase()) {
    case "cr":
      return "\r";
    case "lf":
      return "\n";
    case "crlf":
      return "\r\n";
    default:
      process.stderr.write(`Unsupported --submit-key "${value}". Use cr, lf, or crlf.${os.EOL}`);
      process.exit(2);
  }
}

function resolveCommand(commandName) {
  if (process.platform !== "win32" || path.extname(commandName) || commandName.includes(path.sep)) {
    return commandName;
  }
  try {
    const matches = execFileSync("where.exe", [commandName], { encoding: "utf8" })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return matches.find((match) => match.toLowerCase().endsWith(".cmd")) ?? matches[0] ?? commandName;
  } catch {
    return commandName;
  }
}

function log(message) {
  if (verbose) {
    process.stderr.write(`[always-yes-codex] ${message}${os.EOL}`);
  }
}

function cleanup() {
  if (answerTimer) {
    clearTimeout(answerTimer);
    answerTimer = null;
  }
  if (submitTimer) {
    clearTimeout(submitTimer);
    submitTimer = null;
  }
  process.stdin.setRawMode?.(false);
}

function printHelp() {
  process.stdout.write(`always-yes-codex

Run Codex CLI in a pseudo-terminal and automatically type "yes" for low-risk
direction/continuation questions. Permission, approval, command execution,
install, network, delete, and other high-risk prompts are deliberately skipped.

Usage:
  always-yes-codex [options] [codex args...]

Options:
  --answer <text>       Text to send when a safe prompt is detected. Default: yes
  --submit-key <key>    Submit key sequence: cr, lf, or crlf. Default: cr
  --submit-delay-ms <ms> Delay between answer text and submit key. Default: 500
  --command <command>   Command to wrap. Default: codex
  --delay-ms <ms>       Delay before answering. Default: 250
  --cooldown-ms <ms>    Minimum time between answers. Default: 4000
  --once                Answer at most once per session
  --verbose             Print auto-answer decisions to stderr
  --debug-screen <text> Classify captured screen text and exit
  --echo-test           Echo stdin through the wrapped command for input tests
  --help                Show this help
`);
}

function runSelfTest() {
  const cases = [
    {
      text: "I recommend approach A. Do you want me to continue with this direction?",
      expected: true,
    },
    {
      text: "这个方案可以吗？",
      expected: true,
    },
    {
      text: "你今天喝过咖啡了吗？",
      expected: true,
    },
    {
      text: "你想选哪个方案？",
      expected: false,
    },
    {
      text: "你想选哪个方案？我推荐xxxx",
      expected: true,
    },
    {
      text: "Do you want to allow this command to run outside the sandbox?",
      expected: false,
    },
    {
      text: "是否允许我执行命令安装依赖？",
      expected: false,
    },
  ];

  let failed = 0;
  for (const testCase of cases) {
    const text = normalize(testCase.text);
    const actual = shouldAutoAnswer(text);
    if (actual !== testCase.expected) {
      failed += 1;
      process.stderr.write(`FAIL: ${testCase.text}\n`);
    }
  }

  const repeatPrompt = normalize("你今天喝过水了吗？");
  const repeatKey = autoAnswerPromptKey(repeatPrompt);
  if (repeatKey === null) {
    failed += 1;
    process.stderr.write("FAIL: repeat prompt did not produce a key\n");
  } else {
    const testAnsweredPromptKeys = new Set([repeatKey]);
    const repeatedKey = autoAnswerPromptKey(normalize(`${repeatPrompt}\nyes`));
    if (repeatedKey !== repeatKey || !testAnsweredPromptKeys.has(repeatedKey)) {
      failed += 1;
      process.stderr.write("FAIL: repeat prompt key was not stable\n");
    }
  }

  if (!isInputPromptReady("› ")) {
    failed += 1;
    process.stderr.write("FAIL: empty input prompt was not ready\n");
  }

  if (!isInputPromptReady("› Run /review on my current changes")) {
    failed += 1;
    process.stderr.write("FAIL: Codex placeholder input prompt was not ready\n");
  }

  if (!isInputPromptReady("› Write tests for @filename")) {
    failed += 1;
    process.stderr.write("FAIL: Codex write-tests placeholder was not ready\n");
  }

  if (!isInputPromptReady("› Find and fix a bug in @filename")) {
    failed += 1;
    process.stderr.write("FAIL: Codex bugfix placeholder was not ready\n");
  }

  if (!isInputPromptReady("› Improve documentation in @filename")) {
    failed += 1;
    process.stderr.write("FAIL: Codex documentation placeholder was not ready\n");
  }

  if (!isInputPromptReady("› Use /skills to list available skills")) {
    failed += 1;
    process.stderr.write("FAIL: Codex slash-command placeholder was not ready\n");
  }

  if (isInputPromptReady("› yes")) {
    failed += 1;
    process.stderr.write("FAIL: non-empty input prompt was ready\n");
  }

  const pastedScreen = normalize(`› 随便问我一个问题，让我回答yes or no的那种

• 你今天已经喝过水了吗？

› Run /review on my current changes

  gpt-5.5 high fast · ~`);
  if (autoAnswerPromptKey(pastedScreen) === null || !isInputPromptReady(pastedScreen)) {
    failed += 1;
    process.stderr.write("FAIL: pasted Codex screen was not actionable\n");
  }

  const realScreen = normalize(`› 随便问我一个问题，让我回答yes or no的那种

• 你今天喝过咖啡了吗？

› Write tests for @filename

  gpt-5.5 high fast · ~`);
  if (autoAnswerPromptKey(realScreen) === null || !isInputPromptReady(realScreen)) {
    failed += 1;
    process.stderr.write("FAIL: real Codex screen was not actionable\n");
  }

  const slashCommandScreen = normalize(`› 随便问我一个问题，让我回答yes or no的那种

• 你今天喝过咖啡了吗？

› Use /skills to list available skills

  gpt-5.5 high fast · ~`);
  if (autoAnswerPromptKey(slashCommandScreen) === null || !isInputPromptReady(slashCommandScreen)) {
    failed += 1;
    process.stderr.write("FAIL: slash-command Codex screen was not actionable\n");
  }

  const bugfixScreen = normalize(`› 随便问我一个问题，让我回答yes or no的那种

• 你今天喝水了吗？

› Find and fix a bug in @filename

  gpt-5.5 high fast · ~`);
  if (autoAnswerPromptKey(bugfixScreen) === null || !isInputPromptReady(bugfixScreen)) {
    failed += 1;
    process.stderr.write("FAIL: bugfix-placeholder Codex screen was not actionable\n");
  }

  const documentationScreen = normalize(`› 随便问我一个问题，让我回答yes or no的那种

• 你今天喝过水了吗？

› Improve documentation in @filename

  gpt-5.5 high fast · ~`);
  if (autoAnswerPromptKey(documentationScreen) === null || !isInputPromptReady(documentationScreen)) {
    failed += 1;
    process.stderr.write("FAIL: documentation-placeholder Codex screen was not actionable\n");
  }

  if (failed > 0) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write("self-test passed\n");
}

function runEchoTest() {
  command = process.execPath;
  args.splice(
    0,
    args.length,
    "-e",
    "process.stdin.setEncoding('utf8'); process.stdin.on('data', (data) => { process.stdout.write(data); if (data.includes('\\n') || data.includes('\\r')) process.exit(0); });",
  );
}

function debugScreenText(screenText) {
  const text = normalize(screenText);
  const key = autoAnswerPromptKey(text);
  const inputText = currentInputPromptText(text);
  process.stdout.write(JSON.stringify({
    shouldAnswer: key !== null,
    promptKey: key,
    inputReady: isInputPromptReady(text),
    inputText,
  }, null, 2));
  process.stdout.write(os.EOL);
}
