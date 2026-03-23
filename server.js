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

// ===== Jira カスタムフィールド =====
const CATEGORY_FIELD_ID = "customfield_10117"; // カテゴリ
const ACTION_FIELD_ID = "customfield_10118";   // アクション内容

// ===== 利用可能カテゴリ =====
const ALLOWED_CATEGORIES = [
  "営業",
  "採用",
  "財務",
  "顧客対応",
  "開発",
  "マーケティング",
  "経営",
  "なし",
];

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

// ===== 日本時間の YYYY-MM-DD =====
function formatDateJST(date) {
  const jst = new Date(date.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const yyyy = jst.getFullYear();
  const mm = String(jst.getMonth() + 1).padStart(2, "0");
  const dd = String(jst.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function getTodayAndTomorrowJST() {
  const now = new Date();
  const todayJstBase = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" })
  );

  const tomorrowJstBase = new Date(todayJstBase);
  tomorrowJstBase.setDate(tomorrowJstBase.getDate() + 1);

  return {
    todayStr: formatDateJST(todayJstBase),
    tomorrowStr: formatDateJST(tomorrowJstBase),
  };
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

// ===== 優先度正規化 =====
function normalizePriority(priority) {
  const p = String(priority || "").trim().toLowerCase();

  if (["high", "h", "最高", "高", "至急", "急ぎ", "最優先"].includes(p)) {
    return "High";
  }
  if (["low", "l", "低"].includes(p)) {
    return "Low";
  }
  return "Medium";
}

// ===== プロジェクトキー正規化 =====
function normalizeProjectKey() {
  return "OPS";
}

// ===== カテゴリ正規化 =====
function normalizeCategory(category) {
  const c = String(category || "").trim();
  if (ALLOWED_CATEGORIES.includes(c)) {
    return c;
  }
  return "なし";
}

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
// 形式:
// project|issueType|summary|dueDate|assigneeName|priority|category|description
async function convertToJiraFormat(text) {
  const { todayStr, tomorrowStr } = getTodayAndTomorrowJST();

  const prompt = `
あなたは業務アシスタントです。
ユーザーの自然文を、必ず次の形式1行だけに変換してください。

project|issueType|summary|dueDate|assigneeName|priority|category|description

ルール:
- project は必ず OPS
- issueType は必ず Task
- dueDate は必ず YYYY-MM-DD
- 「明日」は ${tomorrowStr}
- 「今日」「今日中」は ${todayStr}
- 期日が曖昧なら ${tomorrowStr}
- assigneeName は必ず「池田太晟」または「金澤将一」
- 「池田担当」「池田」「自分」「担当者記載なし」は「池田太晟」
- 「金澤担当」「金澤」は「金澤将一」
- priority は必ず High / Medium / Low のいずれか
- 「至急」「急ぎ」「今日中」「最優先」は High
- 「今週中」「対応お願い」「なるはや」は Medium
- 「時間あるとき」「余裕あれば」「急ぎでない」は Low
- priority が判断できなければ Medium

- category は必ず次のいずれか1つ:
  営業 / 採用 / 財務 / 顧客対応 / 開発 / マーケティング / 経営 / なし

- 分類ルール:
  - 営業資料、提案書、商談、見積、営業準備、アポ、顧客提案 → 営業
  - 面接、候補者、求人、採用要件、スクリーニング → 採用
  - 資金繰り、請求、入金、予算、資金調達、会計 → 財務
  - 既存顧客フォロー、CS、問い合わせ対応、導入支援 → 顧客対応
  - システム改修、バグ修正、実装、コード、API、Bot改善 → 開発
  - SNS、広告、LP、導線、キャンペーン、集客 → マーケティング
  - 事業方針、全体整理、経営会議、戦略検討 → 経営
  - 判定できなければ なし

- summary は短く具体的に。句読点は不要
- description は補足内容。補足が薄ければ簡潔に補完してよい
- 区切り文字 | を summary や description に含めない
- 余計な説明は書かない
- 必ず1行のみ返す

入力:
${text}
`;

  const response = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "自然文をJira登録用の1行フォーマットに変換する。余計な説明は一切せず、必ず1行のみ返す。",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  const content = (response.choices?.[0]?.message?.content || "").trim();

  if (!content || !content.includes("|")) {
    throw new Error("AI変換結果が不正です");
  }

  return content.split("\n")[0].trim();
}

// ===== 入力テキスト整形 =====
// 最終形式:
// project|issueType|summary|dueDate|assigneeName|priority|category|description
async function normalizeInputForJira(text) {
  const trimmed = String(text || "").trim();

  if (!trimmed) {
    throw new Error("入力が空です");
  }

  let normalized;

  if (!trimmed.includes("|")) {
    const aiConverted = await convertToJiraFormat(trimmed);
    console.log("AI変換結果:", aiConverted);
    normalized = aiConverted;
  } else {
    const parts = trimmed.split("|").map((v) => v.trim());

    // 旧6項目
    if (parts.length === 6) {
      const [
        projectKey,
        issueType,
        summary,
        dueDate,
        assigneeName,
        description,
      ] = parts;

      normalized = [
        normalizeProjectKey(projectKey),
        issueType || "Task",
        summary || "タイトル未設定",
        dueDate || getTodayAndTomorrowJST().tomorrowStr,
        assigneeName || "池田太晟",
        "Medium",
        "なし",
        description || "補足なし",
      ].join("|");
    }
    // 旧7項目
    else if (parts.length === 7) {
      const [
        projectKey,
        issueType,
        summary,
        dueDate,
        assigneeName,
        priorityName,
        description,
      ] = parts;

      normalized = [
        normalizeProjectKey(projectKey),
        issueType || "Task",
        summary || "タイトル未設定",
        dueDate || getTodayAndTomorrowJST().tomorrowStr,
        assigneeName || "池田太晟",
        normalizePriority(priorityName),
        "なし",
        description || "補足なし",
      ].join("|");
    }
    // 新8項目
    else if (parts.length >= 8) {
      const [
        projectKey,
        issueType,
        summary,
        dueDate,
        assigneeName,
        priorityName,
        category,
        ...rest
      ] = parts;

      const description = rest.join(" ").trim() || "補足なし";

      normalized = [
        normalizeProjectKey(projectKey),
        issueType || "Task",
        summary || "タイトル未設定",
        dueDate || getTodayAndTomorrowJST().tomorrowStr,
        assigneeName || "池田太晟",
        normalizePriority(priorityName),
        normalizeCategory(category),
        description,
      ].join("|");
    } else {
      throw new Error(
        "形式エラー: project|issueType|summary|dueDate|assigneeName|priority|category|description"
      );
    }
  }

  const { todayStr, tomorrowStr } = getTodayAndTomorrowJST();
  const parts = normalized.split("|").map((v) => v.trim());

  if (parts.length < 8) {
    throw new Error("正規化後の形式が不正です");
  }

  let [
    projectKey,
    issueType,
    summary,
    dueDate,
    assigneeName,
    priorityName,
    category,
    ...rest
  ] = parts;

  const description = rest.join(" ").trim() || "補足なし";

  projectKey = "OPS";
  category = normalizeCategory(category);

  if (trimmed.includes("明日")) {
    dueDate = tomorrowStr;
  } else if (trimmed.includes("今日")) {
    dueDate = todayStr;
  }

  return [
    projectKey,
    issueType || "Task",
    summary || "タイトル未設定",
    dueDate,
    assigneeName || "池田太晟",
    normalizePriority(priorityName),
    category,
    description,
  ].join("|");
}

// ===== Jira説明欄（ADF） =====
function buildAdfDescription(text) {
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: String(text || "補足なし"),
          },
        ],
      },
    ],
  };
}

// ===== Jira作成 =====
async function createJiraIssueFromText(rawText) {
  const parts = rawText.split("|").map((v) => v.trim());

  if (parts.length < 8) {
    throw new Error(
      "形式エラー: project|issueType|summary|dueDate|assigneeName|priority|category|description"
    );
  }

  const [
    projectKeyRaw,
    issueTypeRaw,
    summaryRaw,
    dueDateRaw,
    assigneeNameRaw,
    priorityNameRaw,
    categoryRaw,
    ...descRest
  ] = parts;

  const projectKey = normalizeProjectKey(projectKeyRaw);
  const issueType = issueTypeRaw || "Task";
  const summary = summaryRaw || "タイトル未設定";
  const dueDate = dueDateRaw || getTodayAndTomorrowJST().tomorrowStr;
  const assigneeName = assigneeNameRaw || "池田太晟";
  const priorityName = normalizePriority(priorityNameRaw);
  const category = normalizeCategory(categoryRaw);
  const description = descRest.join(" ").trim() || "補足なし";

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
    description: buildAdfDescription(description),
  };

  // OPSのアクション内容
  fields[ACTION_FIELD_ID] = description;

  // OPSのカテゴリ（選択式）
  if (category !== "なし") {
    fields[CATEGORY_FIELD_ID] = { value: category };
  }

  console.log("===== DEBUG START =====");
  console.log("projectKey =", JSON.stringify(projectKey));
  console.log("issueType =", JSON.stringify(issueType));
  console.log("summary =", JSON.stringify(summary));
  console.log("dueDate =", JSON.stringify(dueDate));
  console.log("assigneeName =", JSON.stringify(assigneeName));
  console.log("priorityName =", JSON.stringify(priorityName));
  console.log("category =", JSON.stringify(category));
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
    return {
      jira: res.data,
      normalized: {
        projectKey,
        issueType,
        summary,
        dueDate,
        assigneeName,
        priorityName,
        category,
        description,
      },
    };
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
        const inputForJira = await normalizeInputForJira(text);
        const result = await createJiraIssueFromText(inputForJira);

        const jira = result.jira;
        const normalized = result.normalized;

        await replyLineMessage(
          event.replyToken,
          `【タスク作成完了】
キー: ${jira.key}
プロジェクト: ${normalized.projectKey}
種別: ${normalized.issueType}
タイトル: ${normalized.summary}
期限: ${normalized.dueDate}
担当: ${normalized.assigneeName}
優先度: ${normalized.priorityName}
カテゴリ: ${normalized.category}
内容: ${normalized.description}`
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
