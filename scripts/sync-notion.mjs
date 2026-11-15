import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import notionPkg from '@notionhq/client';
import n2mPkg from 'notion-to-md';

const { Client } = notionPkg;
const NotionToMarkdown = n2mPkg.NotionToMarkdown || n2mPkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const postsDir = path.join(rootDir, 'content', 'posts');
const staticImagesDir = path.join(rootDir, 'static', 'images', 'posts');

// 1. 本地轻量读取 .env 文件（若存在）
function loadEnv() {
  const envPath = path.join(rootDir, '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
}

loadEnv();

const NOTION_TOKEN = process.env.NOTION_TOKEN;
// 优先从命令行参数读取，其次从环境变量读取
let targetInput = process.argv[2] || process.env.NOTION_PAGE_URL;

if (!targetInput || !targetInput.trim()) {
  console.log('ℹ️ [Notion 精准发布] 未指定要发布的文章链接 (NOTION_PAGE_URL 为空)。');
  console.log('   跳过 Notion 同步，直接进行常规构建与部署。');
  console.log('   如需发布特定文章，请在 GitHub Actions 运行窗口输入文章 Share 链接。');
  process.exit(0);
}

if (!NOTION_TOKEN) {
  console.error('❌ 未检测到 NOTION_TOKEN 环境变量，无法访问 Notion API。');
  process.exit(1);
}

// 辅助：从各种格式的 Notion Share 链接中提取标准的 Page ID (带破折号 UUID)
function extractPageId(input) {
  const clean = input.trim();
  // 匹配类似 4199918d-74bb-8080-932e-eeb4b4b85f17 (带连字符)
  const hyphenMatch = clean.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (hyphenMatch) {
    return hyphenMatch[0].toLowerCase();
  }

  // 匹配末尾或路径中的 32 位 hex
  const noHyphenMatch = clean.match(/([0-9a-f]{32})(?:[?&]|$)/i) || clean.match(/[0-9a-f]{32}/i);
  if (noHyphenMatch) {
    const raw = noHyphenMatch[1].toLowerCase();
    return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
  }

  return null;
}

const targetPageId = extractPageId(targetInput);

if (!targetPageId) {
  console.error(`❌ 无法从提供的输入中解析出合法的 Notion Page ID: "${targetInput}"`);
  console.error('   请确保输入的是形如 https://www.notion.so/.../xxx 或 32 位 ID 的合法链接。');
  process.exit(1);
}

const notion = new Client({ auth: NOTION_TOKEN });
const n2m = new NotionToMarkdown({ notionClient: notion });

// 辅助：安全生成文件名 Slug
function slugify(text) {
  const safe = text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[\\/:*?"<>|#\s]+/g, '-')
    .replace(/\-\-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return safe || 'post';
}

// 辅助：下载图片至本地并替换路径
async function downloadAndReplaceImages(markdown, slug) {
  const targetDir = path.join(staticImagesDir, slug);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const imgRegex = /!\[(.*?)\]\((https?:\/\/[^\s\)]+)\)/g;
  let match;
  const downloads = [];
  let index = 1;

  while ((match = imgRegex.exec(markdown)) !== null) {
    const rawAlt = match[1];
    const imgUrl = match[2];
    downloads.push({ fullMatch: match[0], rawAlt, imgUrl, index: index++ });
  }

  let updatedMarkdown = markdown;

  for (const item of downloads) {
    try {
      console.log(`  📥 正在下载图片 [${item.index}]: ${item.imgUrl.slice(0, 60)}...`);
      const resp = await fetch(item.imgUrl);
      if (!resp.ok) {
        console.warn(`  ⚠️ 图片下载跳过 (HTTP ${resp.status}): ${item.imgUrl}`);
        continue;
      }

      const contentType = resp.headers.get('content-type') || '';
      let ext = 'png';
      if (contentType.includes('jpeg') || contentType.includes('jpg')) ext = 'jpg';
      else if (contentType.includes('gif')) ext = 'gif';
      else if (contentType.includes('webp')) ext = 'webp';
      else if (contentType.includes('svg')) ext = 'svg';

      const fileName = `img-${item.index}.${ext}`;
      const filePath = path.join(targetDir, fileName);
      const arrayBuffer = await resp.arrayBuffer();
      fs.writeFileSync(filePath, Buffer.from(arrayBuffer));

      const localRelativeUrl = `/images/posts/${slug}/${fileName}`;
      const replacement = `![${item.rawAlt}](${localRelativeUrl})`;
      updatedMarkdown = updatedMarkdown.replace(item.fullMatch, replacement);
      console.log(`  ✅ 图片已持久化保存至: static/images/posts/${slug}/${fileName}`);
    } catch (err) {
      console.warn(`  ⚠️ 下载图片时发生异常: ${err.message}`);
    }
  }

  return updatedMarkdown;
}

// 格式化日期为 ISO 格式带时区 (+08:00)
function formatDate(dateStr) {
  if (!dateStr) return new Date().toISOString();
  if (dateStr.length === 10) {
    return `${dateStr}T12:00:00+08:00`;
  }
  return dateStr;
}

async function syncSinglePost() {
  console.log(`🚀 开始精准拉取 Notion 页面 [ID: ${targetPageId}]...`);

  let page;
  try {
    page = await notion.pages.retrieve({ page_id: targetPageId });
  } catch (error) {
    console.error(`❌ 无法获取该 Notion 页面:`, error.message);
    console.error(`   请确保该文章已对 integration 开放授权，或链接格式正确。`);
    process.exit(1);
  }

  const props = page.properties || {};

  // 1. 获取标题 (兼容各类属性名称及纯独立页面)
  let title = '';
  for (const [key, val] of Object.entries(props)) {
    if (val.type === 'title' && val.title?.length > 0) {
      title = val.title.map(t => t.plain_text).join('');
      break;
    }
  }
  if (!title && props.title?.title?.length > 0) {
    title = props.title.title.map(t => t.plain_text).join('');
  }

  if (!title.trim()) {
    title = '未命名文章';
  }

  // 2. 获取 Slug
  let slug = '';
  if (props.Slug?.rich_text?.length > 0) {
    slug = props.Slug.rich_text.map(t => t.plain_text).join('').trim();
  }
  if (!slug) {
    slug = slugify(title);
  }
  if (!slug || slug === 'post') {
    slug = `post-${targetPageId.replace(/-/g, '').slice(0, 8)}`;
  }

  // 3. 获取日期 (兼容 Date, Created, created_time)
  let date = props.Date?.date?.start || props.Created?.created_time || page.created_time;
  const isoDate = formatDate(date);

  // 4. 获取标签
  let tags = [];
  for (const val of Object.values(props)) {
    if (val.type === 'multi_select' && val.multi_select?.length > 0) {
      tags = val.multi_select.map(t => t.name);
      break;
    }
  }

  // 5. 获取描述
  let summary = '';
  if (props.Summary?.rich_text?.length > 0) {
    summary = props.Summary.rich_text.map(t => t.plain_text).join('').trim();
  } else if (props.Description?.rich_text?.length > 0) {
    summary = props.Description.rich_text.map(t => t.plain_text).join('').trim();
  }

  // 6. 转换正文 Blocks 为 Markdown
  console.log(`📄 正在转换正文排版与内容...`);
  const mdblocks = await n2m.pageToMarkdown(targetPageId);
  const mdStringObj = n2m.toMarkdownString(mdblocks);
  let contentMarkdown = mdStringObj.parent || '';

  if (!summary) {
    summary = contentMarkdown
      .replace(/[#*`_\[\]()!\n\r]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100);
    if (!summary) summary = title;
  }

  // 7. 处理图片持久化保存
  console.log(`🖼️ 正在检查文章中的配图并持久化保存...`);
  contentMarkdown = await downloadAndReplaceImages(contentMarkdown, slug);

  // 8. 组装 Frontmatter
  const tagsYaml = tags.map(t => JSON.stringify(t)).join(', ');
  const cleanTitle = title.replace(/"/g, '\\"');
  const cleanSummary = summary.replace(/"/g, '\\"');

  const fileContent = `---
title: "${cleanTitle}"
date: ${isoDate}
draft: false
tags: [${tagsYaml}]
description: "${cleanSummary}"
---

${contentMarkdown}
`;

  if (!fs.existsSync(postsDir)) {
    fs.mkdirSync(postsDir, { recursive: true });
  }

  const destPath = path.join(postsDir, `${slug}.md`);
  fs.writeFileSync(destPath, fileContent, 'utf-8');

  console.log(`\n🎉 发布成功！`);
  console.log(`   文章标题: ${title}`);
  console.log(`   生成文件: content/posts/${slug}.md`);
}

syncSinglePost();
