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

// 辅助：安全命名 Slug
function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w\-\u4e00-\u9fa5]+/g, '')
    .replace(/\-\-+/g, '-');
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

async function syncPosts() {
  console.log('🚀 开始从 Notion 数据库拉取文章...');

  let pages = [];
  try {
    // 优先尝试查询 Status 为 Published 的页面
    const queryPayload = {
      database_id: NOTION_DATABASE_ID,
      filter: {
        or: [
          { property: 'Status', status: { equals: 'Published' } },
          { property: 'Status', select: { equals: 'Published' } }
        ]
      }
    };

    let response;
    try {
      response = await notion.databases.query(queryPayload);
    } catch (filterErr) {
      console.log('ℹ️ 未检测到匹配的 Status=Published 过滤器，降级为拉取数据库全量页面...');
      response = await notion.databases.query({ database_id: NOTION_DATABASE_ID });
    }

    pages = response.results || [];
  } catch (error) {
    console.error('❌ 查询 Notion 数据库失败:', error.message);
    process.exit(1);
  }

  console.log(`📄 成功检索到 ${pages.length} 篇待同步文章`);

  if (!fs.existsSync(postsDir)) {
    fs.mkdirSync(postsDir, { recursive: true });
  }

  let successCount = 0;

  for (const page of pages) {
    try {
      const props = page.properties;

      // 1. 获取标题
      let title = '';
      if (props.Title?.title?.length > 0) {
        title = props.Title.title.map(t => t.plain_text).join('');
      } else if (props.Name?.title?.length > 0) {
        title = props.Name.title.map(t => t.plain_text).join('');
      }

      if (!title.trim()) {
        console.warn(`⚠️ 跳过无标题页面: ${page.id}`);
        continue;
      }

      // 2. 获取 Slug
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

      // 3. 获取日期
      let date = props.Date?.date?.start;
      if (!date) {
        date = page.created_time;
      }
      const isoDate = formatDate(date);

      // 4. 获取标签
      let tags = [];
      if (props.Tags?.multi_select) {
        tags = props.Tags.multi_select.map(t => t.name);
      }

      // 5. 获取描述 / 摘要
      let summary = '';
      if (props.Summary?.rich_text?.length > 0) {
        summary = props.Summary.rich_text.map(t => t.plain_text).join('').trim();
      } else if (props.Description?.rich_text?.length > 0) {
        summary = props.Description.rich_text.map(t => t.plain_text).join('').trim();
      }

      // 6. 转换正文 Blocks 为 Markdown
      const mdblocks = await n2m.pageToMarkdown(page.id);
      const mdStringObj = n2m.toMarkdownString(mdblocks);
      let contentMarkdown = mdStringObj.parent || '';

      // 若没有 summary，截取正文前 100 字符
      if (!summary) {
        summary = contentMarkdown
          .replace(/[#*`_\[\]()!\n\r]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 100);
        if (!summary) summary = title;
      }

      // 7. 处理图片持久化
      console.log(`🖼️ 正在检查文章 [${title}] 的图片资源...`);
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
