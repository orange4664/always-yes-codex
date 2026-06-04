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
const delayMs = Number(takeOption(args, "--delay-ms") ?? 250);
const cooldownMs = Number(takeOption(args, "--cooldown-ms") ?? 4000);
const echoTest = takeFlag(args, "--echo-test");

if (takeFlag(args, "--help")) {
  printHelp();
  process.exit(0);
}

if (takeFlag(args, "--self-test")) {
  runSelfTest();
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

  const now = Date.now();
  if (now - lastAnswerAt < cooldownMs) {
    return;
  }

  const text = normalize(recent);
  if (!shouldAutoAnswer(text)) {
    return;
  }

  answerTimer = setTimeout(() => {
    answerTimer = null;
    const current = normalize(recent);
    if (!shouldAutoAnswer(current)) {
      log("skip: prompt changed or became blocked");
      return;
    }
    pty.write(`${answer}\r`);
    lastAnswerAt = Date.now();
    answered = true;
    log(`answered: ${answer}`);
  }, Math.max(0, delayMs));
}

function looksLikeQuestion(text) {
  const promptTail = text.slice(-500);
  return /[?？](?:\s|[:：>»\]\)]|$)/.test(promptTail)
    || /\b\(y\/n\)|\[y\/n\]|\byes\/no\b/i.test(promptTail);
}

function shouldAutoAnswer(text) {
  return !isBlockedPrompt(text)
    && ((looksLikeQuestion(text)
      && (looksLikeYesNoPrompt(text) || looksLikeLowRiskDirectionPrompt(text)))
      || looksLikeRecommendedChoicePrompt(text));
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
  --command <command>   Command to wrap. Default: codex
  --delay-ms <ms>       Delay before answering. Default: 250
  --cooldown-ms <ms>    Minimum time between answers. Default: 4000
  --once                Answer at most once per session
  --verbose             Print auto-answer decisions to stderr
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
