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
const DATABASE_ID = process.env.NOTION_DATABASE_ID || '40d46488-a2a8-4108-ab3c-262350fbe99a';

if (!NOTION_TOKEN) {
  console.log('💡 [Notion 同步] 未检测到 NOTION_TOKEN 环境变量，跳过 Notion 同步。');
  process.exit(0);
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

// 查询数据库中所有打勾 [x] 的已发布文章
async function fetchPublishedPagesFromDatabase(databaseId) {
  console.log(`🔍 正在扫描 Notion 文章库 (ID: ${databaseId})...`);

  let allPages = [];
  try {
    // 兼容 v5 dataSources
    if (notion.dataSources?.query) {
      const db = await notion.databases.retrieve({ database_id: databaseId });
      const dsId = db.data_sources?.[0]?.id || databaseId;
      const res = await notion.dataSources.query({ data_source_id: dsId });
      allPages = res.results || [];
    } else if (typeof notion.databases.query === 'function') {
      const res = await notion.databases.query({ database_id: databaseId });
      allPages = res.results || [];
    } else {
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
        allPages = data.results || [];
      }
    }
  } catch (err) {
    console.error(`❌ 查询数据库失败: ${err.message}`);
    return [];
  }

  // 严格筛选：只有明确打勾 [x] 或标为 Published 的文章才被纳入发布清单
  const publishedPages = [];

  for (const page of allPages) {
    const props = page.properties || {};

    let isPublished = false;

    // 1. 优先检查 Checkbox 类型的勾选属性 (支持列名: 发布, Publish, 已发布)
    for (const [key, val] of Object.entries(props)) {
      if (val.type === 'checkbox') {
        const lowerKey = key.toLowerCase();
        if (lowerKey === '发布' || lowerKey === 'publish' || lowerKey === '已发布') {
          if (val.checkbox === true) {
            isPublished = true;
            break;
          }
        }
      }
    }

    // 2. 兼容 Select 或 Status 类型的发布属性
    if (!isPublished) {
      for (const [key, val] of Object.entries(props)) {
        if (val.type === 'status' || val.type === 'select') {
          const statusName = val.status?.name || val.select?.name || '';
          if (statusName === 'Published' || statusName === '已发布' || statusName === '发布') {
            isPublished = true;
            break;
          }
        }
      }
    }

    if (isPublished) {
      publishedPages.push(page);
    }
  }

  return publishedPages;
}

// 单篇页面处理与生成 Markdown
async function syncPage(page) {
  const pageId = page.id;
  const props = page.properties || {};

  // 1. 获取标题
  let title = '';
  for (const val of Object.values(props)) {
    if (val.type === 'title' && val.title?.length > 0) {
      title = val.title.map(t => t.plain_text).join('');
      break;
    }
  }
  if (!title && props.title?.title?.length > 0) {
    title = props.title.title.map(t => t.plain_text).join('');
  }
  if (!title.trim()) title = '未命名文章';

  // 2. 获取 Slug
  let slug = '';
  if (props.Slug?.rich_text?.length > 0) {
    slug = props.Slug.rich_text.map(t => t.plain_text).join('').trim();
  }
  if (!slug) slug = slugify(title);
  if (!slug || slug === 'post') {
    slug = `post-${pageId.replace(/-/g, '').slice(0, 8)}`;
  }

  // 3. 获取日期
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
  console.log(`📄 正在转换已勾选文章 [${title}] 的正文...`);
  const mdblocks = await n2m.pageToMarkdown(pageId);
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
  console.log(`✨ 成功上线: [${title}] -> content/posts/${slug}.md`);
  return slug;
}

async function main() {
  console.log('🚀 启动 Notion 勾选发布引擎...');

  const publishedPages = await fetchPublishedPagesFromDatabase(DATABASE_ID);

  if (publishedPages.length === 0) {
    console.log('ℹ️ 目前没有检测到任何打勾 [x] 的文章。');
    console.log('   提示：在 Notion 表格中点勾【Publish】(Checkbox)，哪篇想发布就在哪篇点一下打勾。');
    console.log('   未打勾的文章一概不发布，保持当前站点不变。');
    process.exit(0);
  }

  console.log(`📚 共检测到 ${publishedPages.length} 篇明确打勾 [x] 的文章，开始同步上线...`);

  // 记录本次同步生成的 slug 集合，用于实现去勾自动下架
  const activeSlugs = new Set();

  for (const page of publishedPages) {
    const slug = await syncPage(page);
    if (slug) activeSlugs.add(`${slug}.md`);
  }

  // 自动下架：如果本地 content/posts/ 中存在过去从 Notion 同步的文章，但在 Notion 中已被取消勾选，则自动删除下架
  // （保留站点自带的 why-build-this-website.md）
  const existingFiles = fs.readdirSync(postsDir);
  for (const file of existingFiles) {
    if (file === 'why-build-this-website.md' || file.startsWith('_index')) continue;
    if (!activeSlugs.has(file)) {
      console.log(`🗑️ 检测到文章 [${file}] 在 Notion 中已取消勾选，自动下架该页面。`);
      fs.unlinkSync(path.join(postsDir, file));
    }
  }

  console.log(`\n🎉 同步上线完成！当前共有 ${activeSlugs.size} 篇 Notion 文章处于已发布状态。`);
}

main();
