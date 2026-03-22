require("dotenv").config();
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// ===== 環境変数 =====
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_USER_ID = process.env.LINE_USER_ID;

const JIRA_BASE_URL = process.env.JIRA_BASE_URL;
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;

// ===== Middleware =====
app.use("/webhook", express.json());
app.use("/jira", express.json());
app.use("/callback", express.raw({ type: "*/*" }));

app.get("/", (req, res) => {
  res.status(200).send("OK");
});

// ===== LINE署名検証 =====
function validateLineSignature(body, signature) {
  const hash = crypto
    .createHmac("SHA256", LINE_CHANNEL_SECRET)
    .update(body)
    .digest("base64");
  return hash === signature;
}

// ===== 名前 → Jira accountId =====
const ASSIGNEE_MAP = {
  "池田太晟": "712020:49c2350d-16fc-457e-8b2b-159df43d77ad",
  "金澤将一": "ここに金澤さんのJira accountId", // ←後で入れる
};

// ===== 名前 → LINE userId（今回は全部あなたに送る）=====
const LINE_USER_MAP = {
  "池田太晟": "Uba56ca108dd44ab8cd3b044670958c34",
  "金澤将一": "Uba56ca108dd44ab8cd3b044670958c34",
};

// ===== LINE送信 =====
async function pushLineMessageTo(userId, text) {
  if (!userId) {
    throw new Error("LINE userId is empty");
  }

  console.log("LINE PUSH TO:", userId);
  console.log("LINE PUSH TEXT:", text);

  const res = await axios.post(
    "https://api.line.me/v2/bot/message/push",
    {
      to: userId,
      messages: [{ type: "text", text }],
    },
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      },
    }
  );

  console.log("LINE PUSH OK:", res.status);
}

// ===== LINE返信 =====
async function replyLineMessage(replyToken, text) {
  const res = await axios.post(
    "https://api.line.me/v2/bot/message/reply",
    {
      replyToken,
      messages: [{ type: "text", text }],
    },
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      },
    }
  );

  console.log("LINE REPLY OK:", res.status);
}

// ===== Jira作成 =====
async function createJiraIssueFromText(rawText) {
  console.log("RAW TEXT:", rawText);

  const parts = rawText.split("|");
  if (parts.length < 6) {
    throw new Error("形式エラー: PROJECT|IssueType|Summary|DueDate|Assignee|Description");
  }

  const [projectKey, issueType, summary, dueDate, assigneeName, description] = parts;

  const assigneeAccountId = ASSIGNEE_MAP[assigneeName];
  if (!assigneeAccountId) {
    throw new Error(`担当者が見つかりません: ${assigneeName}`);
  }

  const fields = {
    project: { key: projectKey },
    summary,
    issuetype: { name: issueType },
    duedate: dueDate,
    assignee: { accountId: assigneeAccountId },
  };

  if (projectKey === "OPS") {
    fields.customfield_10118 = description;
  } else {
    fields.description = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: description }],
        },
      ],
    };
  }

  console.log("JIRA CREATE FIELDS:", JSON.stringify(fields, null, 2));

  const res = await axios.post(
    `${JIRA_BASE_URL}/rest/api/3/issue`,
    { fields },
    {
      auth: {
        username: JIRA_EMAIL,
        password: JIRA_API_TOKEN,
      },
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    }
  );

  console.log("JIRA CREATE OK:", res.data);
  return res.data;
}

// ===== LINE → Jira =====
app.post("/callback", async (req, res) => {
  try {
    const signature = req.headers["x-line-signature"];
    const rawBody = req.body;

    if (!validateLineSignature(rawBody, signature)) {
      return res.status(401).send("Invalid signature");
    }

    const body = JSON.parse(rawBody.toString("utf8"));
    console.log("=== LINE WEBHOOK ===");
    console.log(JSON.stringify(body, null, 2));

    const events = body.events || [];
    for (const event of events) {
      if (event.type !== "message" || event.message.type !== "text") continue;

      const text = event.message.text.trim();

      try {
        const jira = await createJiraIssueFromText(text);
        await replyLineMessage(event.replyToken, `Jira作成OK: ${jira.key}`);
      } catch (err) {
        console.error("CREATE ERROR:", err.response?.data || err.message);
        await replyLineMessage(event.replyToken, `作成失敗: ${err.message}`);
      }
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("LINE CALLBACK ERROR:", error.message);
    res.status(500).send("ERROR");
  }
});

// ===== Jira → LINE通知 =====
app.post("/webhook", async (req, res) => {
  try {
    console.log("=== JIRA WEBHOOK ===");
    console.log(JSON.stringify(req.body, null, 2));

    const issueKey = req.body.issueKey;
    const summary = req.body.summary;
    const assignee = req.body.assignee;
    const priority = req.body.priority;
    const status = req.body.status;

    const message =
`【期限超過タスク⚠️】
キー: ${issueKey}
タイトル: ${summary}
担当者: ${assignee}
優先度: ${priority}
ステータス: ${status}`;

    const targets = new Set();

    // 固定通知（残す）
    if (LINE_USER_ID) {
      targets.add(LINE_USER_ID);
    }

    // 担当者通知（今回は同じID）
    const assigneeId = LINE_USER_MAP[assignee];
    if (assigneeId) {
      targets.add(assigneeId);
    }

    console.log("WEBHOOK TARGETS:", [...targets]);

    for (const userId of targets) {
      await pushLineMessageTo(userId, message);
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("WEBHOOK ERROR:", error.response?.data || error.message);
    res.status(500).send("ERROR");
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
