require("dotenv").config();
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const OpenAI = require("openai");

const app = express();
const PORT = process.env.PORT || 3000;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ===== 環境変数 =====
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_USER_ID = process.env.LINE_USER_ID;

const JIRA_BASE_URL = process.env.JIRA_BASE_URL;
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;

// ===== Middleware =====
app.use("/webhook", express.json());
app.use("/callback", express.raw({ type: "*/*" }));

// ===== 疎通確認用 =====
app.get("/", (req, res) => {
  res.status(200).send("OK");
});

app.get("/health", (req, res) => {
  res.status(200).send("ok");
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
  "金澤将一": "6121089528ae75006afc73b3",
};

// ===== 名前 → LINE userId =====
const LINE_USER_MAP = {
  "池田太晟": "Uba56ca108dd44ab8cd3b044670958c34",
  "金澤将一": "U743062d8c9d606c8a30c971bf1a650c5",
};

// ===== LINE送信 =====
async function pushLineMessageTo(userId, text) {
  if (!userId) return;

  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    {
      to: userId,
      messages: [{ type: "text", text }],
    },
    {
      headers: {
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

// ===== LINE返信 =====
async function replyLineMessage(replyToken, text) {
  await axios.post(
    "https://api.line.me/v2/bot/message/reply",
    {
      replyToken,
      messages: [{ type: "text", text }],
    },
    {
      headers: {
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

// ===== AIで自然文 → Jira形式変換 =====
async function convertToJiraFormat(text) {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  const yyyy = tomorrow.getFullYear();
  const mm = String(tomorrow.getMonth() + 1).padStart(2, "0");
  const dd = String(tomorrow.getDate()).padStart(2, "0");
  const defaultDate = `${yyyy}-${mm}-${dd}`;

  const prompt = `
あなたは業務アシスタントです。
ユーザーの自然文を、必ず次の形式1行だけに変換してください。

project|issueType|summary|dueDate|assigneeName|priority|description

ルール:
- project は OPS / SALES / HR のいずれか
- 経営、社内運用、会議、管理、オペレーション系は OPS
- 営業、提案、顧客対応、商談、資料作成、顧客フォロー系は SALES
- 採用、候補者、面接、求人、スクリーニング、面談、採用要件系は HR
- issueType は必ず Task
- dueDate は YYYY-MM-DD
- 「明日」は明日の日付
- 「今日中」は今日の日付
- 期日が曖昧なら ${defaultDate}
- assigneeName は必ず「池田太晟」または「金澤将一」
- 「池田担当」や担当者記載なしは「池田太晟」
- 「金澤担当」は「金澤将一」
- priority は High / Medium / Low
- 「至急」「急ぎ」「今日中」「最優先」は High
- 「今週中」「対応お願い」「なるはや」は Medium
- 「時間あるとき」「余裕あれば」「急ぎでない」は Low
- priority が判断できなければ Medium
- summary は短く具体的に
- description は補足内容
- 余計な説明は書かない
- 必ず1行のみ返す

入力:
${text}
`;

  const response = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [{ role: "user", content: prompt }],
  });

  return response.choices[0].message.content.trim();
}

// ===== Jira作成 =====
async function createJiraIssueFromText(rawText) {
  const parts = rawText.split("|").map((v) => v.trim());

  if (parts.length < 7) {
    throw new Error(
      "形式エラー: project|issueType|summary|dueDate|assigneeName|priority|description で入力してください"
    );
  }

  const [
    projectKey,
    issueType,
    summary,
    dueDate,
    assigneeName,
    priorityName,
    description,
  ] = parts;

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
    priority: { name: priorityName },
  };

  if (projectKey === "OPS") {
    fields.customfield_10118 = description;
  }

  console.log("===== DEBUG START =====");
  console.log("projectKey =", JSON.stringify(projectKey));
  console.log("issueType =", JSON.stringify(issueType));
  console.log("summary =", JSON.stringify(summary));
  console.log("dueDate =", JSON.stringify(dueDate));
  console.log("assigneeName =", JSON.stringify(assigneeName));
  console.log("priorityName =", JSON.stringify(priorityName));
  console.log("description =", JSON.stringify(description));
  console.log("fields =", JSON.stringify(fields, null, 2));
  console.log("===== DEBUG END =====");

  try {
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

    console.log("JIRA SUCCESS:", res.data);
    return res.data;
  } catch (error) {
    console.error(
      "JIRA ERROR:",
      error.response?.status,
      error.response?.data || error.message
    );
    throw new Error(
      `Jira作成失敗: ${error.response?.status || ""} ${
        typeof error.response?.data === "string"
          ? error.response.data
          : JSON.stringify(error.response?.data || error.message)
      }`
    );
  }
}

// ===== LINE → Jira =====
app.post("/callback", async (req, res) => {
  try {
    const signature = req.headers["x-line-signature"];
    const rawBody = req.body;

    if (!validateLineSignature(rawBody, signature)) {
      console.log("LINE SIGNATURE ERROR");
      return res.status(401).send("Invalid signature");
    }

    const body = JSON.parse(rawBody.toString("utf8"));
    console.log("LINE EVENT:", JSON.stringify(body, null, 2));

    for (const event of body.events) {
      if (event.type !== "message") continue;
      if (event.message.type !== "text") continue;

      const text = event.message.text;

      try {
        let inputForJira = text;

        if (text.includes("|")) {
          const oldParts = text.split("|").map((v) => v.trim());

          if (oldParts.length === 6) {
            const [
              projectKey,
              issueType,
              summary,
              dueDate,
              assigneeName,
              description,
            ] = oldParts;

            inputForJira = `${projectKey}|${issueType}|${summary}|${dueDate}|${assigneeName}|Medium|${description}`;
          } else {
            inputForJira = oldParts.join("|");
          }
        } else {
          inputForJira = await convertToJiraFormat(text);
          console.log("AI変換結果:", inputForJira);
        }

        const jira = await createJiraIssueFromText(inputForJira);

        const [
          projectKey,
          issueType,
          summary,
          dueDate,
          assigneeName,
          priorityName,
          description,
        ] = inputForJira.split("|").map((v) => v.trim());

        await replyLineMessage(
          event.replyToken,
          `【タスク作成完了】
キー: ${jira.key}
プロジェクト: ${projectKey}
種別: ${issueType}
タイトル: ${summary}
期限: ${dueDate}
担当: ${assigneeName}
優先度: ${priorityName}
内容: ${description}`
        );
      } catch (e) {
        console.error("CALLBACK ERROR:", e.message);
        await replyLineMessage(event.replyToken, `エラー: ${e.message}`);
      }
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("CALLBACK FATAL ERROR:", error.message);
    res.status(500).send("Internal Server Error");
  }
});

// ===== Jira → LINE通知 =====
app.post("/webhook", async (req, res) => {
  try {
    console.log("JIRA WEBHOOK BODY:", JSON.stringify(req.body, null, 2));

    const { issueKey, summary, assignee, priority, status } = req.body;

    const message = `【期限超過タスク⚠️】
キー: ${issueKey}
タイトル: ${summary}
担当者: ${assignee}
優先度: ${priority}
ステータス: ${status}`;

    const targets = new Set();

    if (LINE_USER_ID) targets.add(LINE_USER_ID);

    const userId = LINE_USER_MAP[assignee];
    if (userId) targets.add(userId);

    for (const id of targets) {
      await pushLineMessageTo(id, message);
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("WEBHOOK ERROR:", error.response?.data || error.message);
    res.status(500).send("Webhook Error");
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
