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
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

if (!NOTION_TOKEN || !NOTION_DATABASE_ID) {
  console.log('💡 [Notion 同步] 未检测到 NOTION_TOKEN 或 NOTION_DATABASE_ID 环境变量。');
  console.log('   如需在本地同步 Notion，请在根目录创建 .env 文件并填入：');
  console.log('   NOTION_TOKEN=ntn_xxxxxx');
  console.log('   NOTION_DATABASE_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  console.log('   本次跳过 Notion 同步。');
  process.exit(0);
}

const notion = new Client({ auth: NOTION_TOKEN });
const n2m = new NotionToMarkdown({ notionClient: notion });

// 辅助：安全生成 Slug 文件名
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

  // 匹配 Markdown 图片语法: ![alt](url)
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
        console.warn(`  ⚠️ 图片下载失败 (HTTP ${resp.status}): ${item.imgUrl}`);
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

// 查询页面：兼容 Notion SDK v5 dataSources、旧版 databases.query 以及原生 REST
async function fetchPagesFromDatabase(databaseId) {
  // 1. 尝试使用 Notion SDK v5 dataSources.query
  if (notion.dataSources?.query) {
    try {
      const db = await notion.databases.retrieve({ database_id: databaseId });
      const dsId = db.data_sources?.[0]?.id || databaseId;
      const res = await notion.dataSources.query({ data_source_id: dsId });
      if (res.results) return res.results;
    } catch (e) {
      console.log('ℹ️ dataSources.query 模式不可用，降级处理:', e.message);
    }
  }

  // 2. 尝试旧版 databases.query
  if (typeof notion.databases.query === 'function') {
    try {
      const res = await notion.databases.query({ database_id: databaseId });
      if (res.results) return res.results;
    } catch (e) {
      console.log('ℹ️ databases.query 模式不可用，降级处理:', e.message);
    }
  }

  // 3. 原生 REST 请求 fallback
  const resp = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({})
  });
  if (resp.ok) {
    const data = await resp.json();
    return data.results || [];
  }

  throw new Error(`无法查询数据库: HTTP ${resp.status} ${resp.statusText}`);
}

async function syncPosts() {
  const targetPageUrl = process.env.NOTION_PAGE_URL;
  if (!targetPageUrl && !process.env.FORCE_SYNC_ALL) {
    console.log('💡 [Notion 同步] 当前未指定要单篇发布的 NOTION_PAGE_URL。');
    console.log('   为保护隐私并防止未完成草稿误发，全量自动同步已暂停。');
    console.log('   如需发布特定文章，请传入 NOTION_PAGE_URL 或在 GitHub Actions 输入文章链接。');
    process.exit(0);
  }

  let pages = [];
  try {
    pages = await fetchPagesFromDatabase(NOTION_DATABASE_ID);
  } catch (error) {
    console.error('❌ 查询 Notion 数据库失败:', error.message);
    process.exit(1);
  }

  console.log(`📄 成功从 Notion 检索到 ${pages.length} 篇页面`);

  if (!fs.existsSync(postsDir)) {
    fs.mkdirSync(postsDir, { recursive: true });
  }

  let successCount = 0;

  for (const page of pages) {
    try {
      const props = page.properties;

      // 1. 获取标题
      let title = '';
      if (props.Name?.title?.length > 0) {
        title = props.Name.title.map(t => t.plain_text).join('');
      } else if (props.Title?.title?.length > 0) {
        title = props.Title.title.map(t => t.plain_text).join('');
      }

      if (!title.trim()) {
        console.warn(`⚠️ 跳过无标题页面: ${page.id}`);
        continue;
      }

      // 2. 检查 Status（如果存在且设置了值，只同步 Published）
      const statusVal = props.Status?.status?.name || props.Status?.select?.name;
      if (statusVal && statusVal !== 'Published' && statusVal !== '已发布') {
        console.log(`ℹ️ 跳过非 Published 状态页面 [${title}] (当前状态: ${statusVal})`);
        continue;
      }

      // 3. 获取 Slug
      let slug = '';
      if (props.Slug?.rich_text?.length > 0) {
        slug = props.Slug.rich_text.map(t => t.plain_text).join('').trim();
      }
      if (!slug) {
        slug = slugify(title);
      }
      if (!slug) {
        slug = `post-${page.id.replace(/-/g, '').slice(0, 8)}`;
      }

      // 4. 获取日期 (兼容 Created, Date, created_time)
      let date = props.Date?.date?.start || props.Created?.created_time || page.created_time;
      const isoDate = formatDate(date);

      // 5. 获取标签
      let tags = [];
      if (props.Tags?.multi_select) {
        tags = props.Tags.multi_select.map(t => t.name);
      }

      // 6. 获取描述 / 摘要
      let summary = '';
      if (props.Summary?.rich_text?.length > 0) {
        summary = props.Summary.rich_text.map(t => t.plain_text).join('').trim();
      } else if (props.Description?.rich_text?.length > 0) {
        summary = props.Description.rich_text.map(t => t.plain_text).join('').trim();
      }

      // 7. 转换正文 Blocks 为 Markdown
      const mdblocks = await n2m.pageToMarkdown(page.id);
      const mdStringObj = n2m.toMarkdownString(mdblocks);
      let contentMarkdown = mdStringObj.parent || '';

      // 若没有 summary，从正文提取前 100 字符纯文本
      if (!summary) {
        summary = contentMarkdown
          .replace(/[#*`_\[\]()!\n\r]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 100);
        if (!summary) summary = title;
      }

      // 8. 处理图片持久化
      contentMarkdown = await downloadAndReplaceImages(contentMarkdown, slug);

      // 9. 组装 Frontmatter（严格遵循 site.test.mjs 契约）
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

      const destPath = path.join(postsDir, `${slug}.md`);
      fs.writeFileSync(destPath, fileContent, 'utf-8');
      console.log(`✨ 成功同步: [${title}] -> content/posts/${slug}.md`);
      successCount++;
    } catch (pageErr) {
      console.error(`❌ 处理页面 ${page.id} 失败:`, pageErr.message);
    }
  }

  console.log(`\n🎉 全部同步完成！成功同步 ${successCount} 篇文章。`);
}

syncPosts();
