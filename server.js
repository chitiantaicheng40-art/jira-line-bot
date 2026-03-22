require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;

// ===== 環境変数 =====
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

const JIRA_BASE_URL = process.env.JIRA_BASE_URL;
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;

// ===== 共通認証ヘッダー =====
function getJiraHeaders() {
  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64");
  return {
    Authorization: `Basic ${auth}`,
    Accept: "application/json",
    "Content-Type": "application/json"
  };
}

// ===== LINE返信 =====
async function replyLine(replyToken, message) {
  await axios.post(
    "https://api.line.me/v2/bot/message/reply",
    {
      replyToken,
      messages: [
        {
          type: "text",
          text: message
        }
      ]
    },
    {
      headers: {
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

// ===== メッセージ解析 =====
function parseMessage(text) {
  const cleaned = text.replace(/\n/g, "").trim();
  const parts = cleaned.split("|").map((p) => p.trim());

  if (parts.length < 6) {
    throw new Error("形式: プロジェクト | 種別 | 件名 | 期限 | 担当 | 詳細");
  }

  return {
    projectKey: parts[0],
    issueType: parts[1],
    summary: parts[2],
    dueDate: parts[3],
    assignee: parts[4],
    description: parts[5]
  };
}

// ===== Jiraユーザー検索 =====
async function resolveAssigneeAccountId(query) {
  if (!query) return null;

  const response = await axios.get(
    `${JIRA_BASE_URL}/rest/api/3/user/search`,
    {
      headers: getJiraHeaders(),
      params: { query }
    }
  );

  const users = response.data || [];

  const exact = users.find(
    (u) => (u.displayName || "").trim() === query.trim()
  );

  if (!exact) {
    throw new Error(`担当者が見つかりません: ${query}`);
  }

  return exact.accountId;
}

// ===== Jira作成 =====
async function createJira(task) {
  const fields = {
    project: { key: task.projectKey },
    summary: task.summary,
    issuetype: { name: task.issueType },
    duedate: task.dueDate,

    // 🔥 ここが超重要（description修正）
    description: {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: task.description || ""
            }
          ]
        }
      ]
    }
  };

  if (task.assignee) {
    const accountId = await resolveAssigneeAccountId(task.assignee);
    fields.assignee = { accountId };
  }

  const response = await axios.post(
    `${JIRA_BASE_URL}/rest/api/3/issue`,
    { fields },
    {
      headers: getJiraHeaders()
    }
  );

  return response.data;
}

// ===== Webhook =====
app.post("/webhook", async (req, res) => {
  try {
    const events = req.body.events || [];

    for (const e of events) {
      if (e.type !== "message") continue;

      try {
        const task = parseMessage(e.message.text);
        const result = await createJira(task);

        await replyLine(e.replyToken, `作成成功: ${result.key}`);
      } catch (err) {
        console.error(err.response?.data || err.message);
        await replyLine(e.replyToken, `失敗: ${err.message}`);
      }
    }

    res.status(200).end();
  } catch (err) {
    console.error(err);
    res.status(500).end();
  }
});

app.listen(PORT, () => {
  console.log("Server running:", PORT);
});
