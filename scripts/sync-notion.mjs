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
// 默认【博客发布台】ID，亦可由环境变量覆盖
const DASHBOARD_ID = process.env.NOTION_DASHBOARD_ID || '4199918d-74bb-8080-932e-eeb4b4b85f17';
const SINGLE_PAGE_INPUT = process.argv[2] || process.env.NOTION_PAGE_URL;

if (!NOTION_TOKEN) {
  console.log('💡 [Notion 同步] 未检测到 NOTION_TOKEN 环境变量，跳过 Notion 同步。');
  process.exit(0);
}

const notion = new Client({ auth: NOTION_TOKEN });
const n2m = new NotionToMarkdown({ notionClient: notion });

// 辅助：从各种格式链接中提取标准 Page ID (带破折号 UUID)
function extractPageId(input) {
  if (!input) return null;
  const clean = input.trim();
  const hyphenMatch = clean.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (hyphenMatch) return hyphenMatch[0].toLowerCase();

  const noHyphenMatch = clean.match(/([0-9a-f]{32})(?:[?&]|$)/i) || clean.match(/[0-9a-f]{32}/i);
  if (noHyphenMatch) {
    const raw = noHyphenMatch[1].toLowerCase();
    return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
  }
  return null;
}

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

// 扫描【博客发布台】内部包含的所有文章 ID
async function getArticleIdsFromDashboard(dashboardId) {
  console.log(`🔍 正在扫描【博客发布台】(ID: ${dashboardId}) 的展示清单...`);
  const articleIds = new Set();

  try {
    let hasMore = true;
    let startCursor = undefined;

    while (hasMore) {
      const response = await notion.blocks.children.list({
        block_id: dashboardId,
        start_cursor: startCursor,
        page_size: 100
      });

      for (const block of response.results) {
        // 1. 直接拖入/创建的子页面 (child_page)
        if (block.type === 'child_page') {
          articleIds.add(block.id);
        }
        // 2. 通过 /link to page 建立的链接 (link_to_page)
        else if (block.type === 'link_to_page' && block.link_to_page?.page_id) {
          articleIds.add(block.link_to_page.page_id);
        }
        // 3. 段落、列表等文本中的 mention 或 URL
        else if (block[block.type]?.rich_text) {
          for (const rt of block[block.type].rich_text) {
            if (rt.type === 'mention' && rt.mention?.type === 'page' && rt.mention.page?.id) {
              articleIds.add(rt.mention.page.id);
            } else if (rt.href) {
              const parsed = extractPageId(rt.href);
              if (parsed) articleIds.add(parsed);
            }
          }
        }
      }

      hasMore = response.has_more;
      startCursor = response.next_cursor;
    }
  } catch (err) {
    console.warn(`⚠️ 读取发布台 blocks 遇到问题: ${err.message}`);
  }

  return Array.from(articleIds);
}

// 单篇页面拉取并转换为 Markdown
async function syncPageById(pageId) {
  let page;
  try {
    page = await notion.pages.retrieve({ page_id: pageId });
  } catch (error) {
    console.error(`❌ 无法访问页面 [ID: ${pageId}]:`, error.message);
    return false;
  }

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
  console.log(`📄 正在转换文章 [${title}] 的正文与排版...`);
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

  // 7. 处理图片持久化
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
  console.log(`✨ 成功发布: [${title}] -> content/posts/${slug}.md`);
  return true;
}

async function main() {
  console.log('🚀 启动 Notion 博客发布引擎...');

  let targetIds = [];

  // 优先情况 A：命令行或环境变量明确指定了单篇文章
  if (SINGLE_PAGE_INPUT) {
    const singleId = extractPageId(SINGLE_PAGE_INPUT);
    if (singleId) {
      console.log(`🎯 模式: 精准发布单篇文章 (ID: ${singleId})`);
      targetIds.push(singleId);
    }
  }

  // 常规情况 B：从【博客发布台】展架中提取要发布的文章清单
  if (targetIds.length === 0) {
    const cleanDashboardId = extractPageId(DASHBOARD_ID);
    if (cleanDashboardId) {
      targetIds = await getArticleIdsFromDashboard(cleanDashboardId);
    }
  }

  if (targetIds.length === 0) {
    console.log('ℹ️ 【博客发布台】目前未放置任何要发布的文章。');
    console.log('   提示：在 Notion 中打开【博客发布台】，打字输入 @文章标题 或拖入子页面，即可将其发布。');
    console.log('   本次跳过 Notion 同步，保持现有站点内容不变。');
    process.exit(0);
  }

  console.log(`📚 共发现 ${targetIds.length} 篇待发布文章，开始逐一处理...`);

  let count = 0;
  for (const id of targetIds) {
    const ok = await syncPageById(id);
    if (ok) count++;
  }

  console.log(`\n🎉 发布完成！共成功发布 ${count} 篇文章。`);
}

main();
