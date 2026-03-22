require("dotenv").config();
const express = require("express");
const crypto = require("crypto");

const app = express();

// LINE署名検証のため raw body を保持
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

const PORT = process.env.PORT || 10000;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_USER_ID_DEFAULT = process.env.LINE_USER_ID_DEFAULT;

const JIRA_BASE_URL = process.env.JIRA_BASE_URL;
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const JIRA_DEFAULT_PROJECT = process.env.JIRA_DEFAULT_PROJECT || "OPS";
const JIRA_DEFAULT_ISSUE_TYPE = process.env.JIRA_DEFAULT_ISSUE_TYPE || "Task";

// Jiraの実際のプロジェクトキーに合わせて必要なら修正
const PROJECT_MAP = {
  OPS: "OPS",
  PRODUCT: "PRODUCT",
  SALES: "SALES",
  契約状況: "契約状況",
};

// Jiraの accountId に置き換える
const JIRA_USER_MAP = {
  "池田太晟": "ここに池田さんのaccountId",
  "池田 太晟": "ここに池田さんのaccountId",
  "太晟": "ここに池田さんのaccountId",
  "金澤": "ここに金澤さんのaccountId",
  "金澤将一": "ここに金澤さんのaccountId",
  "金澤 将一": "ここに金澤さんのaccountId",
  "OU": "ここにOUさんのaccountId",
};

const LINE_USER_MAP = {
  "池田太晟": "Uba56ca108dd44ab8cd3b044670958c34",
  "池田 太晟": "Uba56ca108dd44ab8cd3b044670958c34",
  "金澤": "U743062d8c9d606c8a30c971bf1a650c5",
  "金澤将一": "U743062d8c9d606c8a30c971bf1a650c5",
  "金澤 将一": "U743062d8c9d606c8a30c971bf1a650c5",
};

function resolveLineUserId(name) {
  if (!name) return LINE_USER_ID_DEFAULT;

  const normalized = name.trim();

  if (LINE_USER_MAP[normalized]) {
    return LINE_USER_MAP[normalized];
  }
  if (normalized.includes("金澤")) {
    return LINE_USER_MAP["金澤将一"];
  }
  if (normalized.includes("池田")) {
    return LINE_USER_MAP["池田太晟"];
  }

  return LINE_USER_ID_DEFAULT;
}

function resolveJiraAccountId(name) {
  if (!name) return null;

  const normalized = name.trim();

  if (JIRA_USER_MAP[normalized]) {
    return JIRA_USER_MAP[normalized];
  }
  if (normalized.includes("金澤")) {
    return JIRA_USER_MAP["金澤将一"] || null;
  }
  if (normalized.includes("池田")) {
    return JIRA_USER_MAP["池田太晟"] || null;
  }

  return null;
}

function verifyLineSignature(req) {
  const signature = req.headers["x-line-signature"];
  if (!signature || !LINE_CHANNEL_SECRET || !req.rawBody) return false;

  const expected = crypto
    .createHmac("SHA256", LINE_CHANNEL_SECRET)
    .update(req.rawBody)
    .digest("base64");

  return signature === expected;
}

async function replyLineMessage(replyToken, text) {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });

  const body = await res.text();
  if (!res.ok) {
    throw new Error(`LINE reply failed: ${res.status} ${body}`);
  }
  return body;
}

async function pushLineMessage(to, text) {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      to,
      messages: [{ type: "text", text }],
    }),
  });

  const body = await res.text();
  if (!res.ok) {
    throw new Error(`LINE push failed: ${res.status} ${body}`);
  }
  return body;
}

function parseLineTaskMessage(text) {
  if (!text) return null;

  const parts = text.trim().split("｜");
  if (parts.length < 6) {
    throw new Error(
      "形式は\nプロジェクト｜種別｜件名｜期限｜担当｜詳細\nで送ってください。"
    );
  }

  const projectName = parts[0].trim();
  const issueType = parts[1].trim();
  const summary = parts[2].trim();
  const dueDate = parts[3].trim();
  const assigneeName = parts[4].trim();
  const description = parts.slice(5).join("｜").trim();

  const projectKey = PROJECT_MAP[projectName] || projectName || JIRA_DEFAULT_PROJECT;

  if (!summary) {
    throw new Error("件名が空です。");
  }

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(dueDate)) {
    throw new Error("期限は YYYY-MM-DD 形式で入力してください。");
  }

  return {
    projectKey,
    issueType: issueType || JIRA_DEFAULT_ISSUE_TYPE,
    summary,
    dueDate,
    assigneeName,
    description: description || "LINEから登録",
  };
}

async function createJiraIssue(task) {
  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    throw new Error("Jira環境変数が不足しています。");
  }

  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64");
  const accountId = resolveJiraAccountId(task.assigneeName);

  const fields = {
    project: {
      key: task.projectKey || JIRA_DEFAULT_PROJECT,
    },
    summary: task.summary,
    issuetype: {
      name: task.issueType || JIRA_DEFAULT_ISSUE_TYPE,
    },
    description: {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: task.description,
            },
          ],
        },
      ],
    },
    duedate: task.dueDate,
  };

  if (accountId) {
    fields.assignee = { id: accountId };
  }

  const res = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({ fields }),
  });

  const bodyText = await res.text();

  if (!res.ok) {
    throw new Error(`Jira create failed: ${res.status} ${bodyText}`);
  }

  return JSON.parse(bodyText);
}

// ヘルスチェック
app.get("/health", (_req, res) => {
  res.status(200).send("OK");
});

// LINE → Jira
app.post("/webhook", async (req, res) => {
  try {
    console.log("=== LINE WEBHOOK ===");
    console.log(JSON.stringify(req.body, null, 2));

    const valid = verifyLineSignature(req);
    console.log("signature valid =", valid);

    if (!valid) {
      return res.status(401).send("Invalid signature");
    }

    const events = req.body.events || [];

    for (const event of events) {
      try {
        if (event.type !== "message" || event.message?.type !== "text") {
          continue;
        }

        const text = event.message.text;
        const replyToken = event.replyToken;

        const task = parseLineTaskMessage(text);
        const jiraResult = await createJiraIssue(task);

        await replyLineMessage(
          replyToken,
          [
            "Jiraに登録しました！",
            `キー: ${jiraResult.key}`,
            `プロジェクト: ${task.projectKey}`,
            `種別: ${task.issueType}`,
            `件名: ${task.summary}`,
            `期限: ${task.dueDate}`,
            `担当: ${task.assigneeName || "未設定"}`,
          ].join("\n")
        );
      } catch (err) {
        console.error("LINE event error:", err.message);

        if (event.replyToken) {
          try {
            await replyLineMessage(
              event.replyToken,
              `登録に失敗しました。\n${err.message}`
            );
          } catch (replyErr) {
            console.error("LINE reply error:", replyErr.message);
          }
        }
      }
    }

    res.status(200).end();
  } catch (err) {
    console.error("Webhook error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Jira → LINE
app.post("/jira", async (req, res) => {
  try {
    const body = req.body || {};

    console.log("Jira webhook received:", body);

    const issueKey = body.issueKey || "NO-KEY";
    const summary = body.summary || "";
    const assignee = body.assignee || "";
    const priority = body.priority || "-";
    const status = body.status || "-";
    const dueDate = body.dueDate || "-";
    const url = body.url || "";

    const targetLineUserId = resolveLineUserId(assignee);

    console.log("assignee =", assignee);
    console.log("targetLineUserId =", targetLineUserId);

    const message = [
      "【Jira通知】",
      `${issueKey} ${summary}`,
      `担当: ${assignee || "未設定"}`,
      `優先度: ${priority}`,
      `状態: ${status}`,
      `期限: ${dueDate}`,
      "",
      url,
    ].join("\n");

    await pushLineMessage(targetLineUserId, message);

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Jira LINE bot listening on port ${PORT}`);
});
