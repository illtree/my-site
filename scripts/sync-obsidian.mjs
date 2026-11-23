import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const postsDir = path.join(rootDir, 'content', 'posts');
const staticImagesDir = path.join(rootDir, 'static', 'images', 'posts');

// 1. 读取环境或默认的 Obsidian Vault 路径
const DEFAULT_VAULT_PATH = 'C:\\Users\\alway\\OneDrive\\obsidian';
const vaultPath = process.env.OBSIDIAN_VAULT_PATH || DEFAULT_VAULT_PATH;

console.log('====================================================');
console.log('🚀 Obsidian 勾选发布引擎启动');
console.log(`📁 目标 Obsidian 知识库: ${vaultPath}`);
console.log('====================================================\n');

if (!fs.existsSync(vaultPath)) {
  console.error(`❌ 未找到 Obsidian 知识库目录: ${vaultPath}`);
  console.error('请确认路径是否正确，或在环境变量中设置 OBSIDIAN_VAULT_PATH。');
  process.exit(1);
}

// 辅助：生成 URL-safe Slug
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

// 格式化日期为 ISO 8601 带时区 (+08:00)
function formatIsoDate(dateVal) {
  if (!dateVal) {
    const now = new Date();
    return now.toISOString().replace(/\.\d{3}Z$/, '+08:00');
  }

  const str = String(dateVal).trim();
  // YYYY-MM-DD HH:MM
  const dtMatch = str.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?/);
  if (dtMatch) {
    const sec = dtMatch[3] || '00';
    return `${dtMatch[1]}T${dtMatch[2]}:${sec}+08:00`;
  }
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return `${str}T12:00:00+08:00`;
  }

  // Fallback to JS Date
  try {
    const d = new Date(str);
    if (!isNaN(d.getTime())) {
      const pad = (n) => String(n).padStart(2, '0');
      const y = d.getFullYear();
      const m = pad(d.getMonth() + 1);
      const day = pad(d.getDate());
      const h = pad(d.getHours());
      const min = pad(d.getMinutes());
      const s = pad(d.getSeconds());
      return `${y}-${m}-${day}T${h}:${min}:${s}+08:00`;
    }
  } catch {}

  return new Date().toISOString().replace(/\.\d{3}Z$/, '+08:00');
}

// 递归查找指定目录下所有符合条件的 Markdown 文件
function scanVaultMarkdownFiles(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    // 忽略 .obsidian 配置目录与 attachments 附件目录
    if (entry.name === '.obsidian' || entry.name === 'attachments') continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...scanVaultMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(fullPath);
    }
  }
  return results;
}

// 解析并提取 Frontmatter
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { hasFm: false, fm: {}, body: content };

  const rawYaml = match[1];
  const body = content.slice(match[0].length).trim();
  const fm = {};

  const lines = rawYaml.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0) {
      const key = trimmed.slice(0, colonIdx).trim().toLowerCase();
      let val = trimmed.slice(colonIdx + 1).trim();
      // 去除首尾引号
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      fm[key] = val;
    }
  }

  return { hasFm: true, rawFm: rawYaml, fm, body };
}

// 检查笔记是否勾选了发布
function isPostPublished(fm) {
  if (!fm.publish) return false;
  const val = String(fm.publish).trim().toLowerCase();
  return val === 'true' || val === 'yes' || val === '1' || val === '已发布';
}

// 在整个 Vault 中按文件名搜索图片
function findImageInVault(imgRef, noteDir) {
  // 1. 先尝试相对路径解析
  const relPath = path.resolve(noteDir, imgRef);
  if (fs.existsSync(relPath)) return relPath;

  // 2. 尝试解码 URL
  try {
    const decodedRel = path.resolve(noteDir, decodeURIComponent(imgRef));
    if (fs.existsSync(decodedRel)) return decodedRel;
  } catch {}

  // 3. 在 attachments 根目录下搜索
  const baseName = path.basename(decodeURIComponent(imgRef));
  const rootAttachments = path.join(vaultPath, 'attachments');
  if (fs.existsSync(rootAttachments)) {
    // 递归查找匹配文件名的附件
    function searchDir(d) {
      const entries = fs.readdirSync(d, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          const found = searchDir(full);
          if (found) return found;
        } else if (e.name.toLowerCase() === baseName.toLowerCase()) {
          return full;
        }
      }
      return null;
    }
    const found = searchDir(rootAttachments);
    if (found) return found;
  }

  return null;
}

// 处理正文中的图片引用，复制到 static/images/posts 并替换链接
function processImages(content, noteDir, slug) {
  const targetDir = path.join(staticImagesDir, slug);
  let updatedContent = content;

  // 1. 标准 Markdown 图片: ![alt](url)
  const mdImgRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let match;
  const mdImages = [];
  while ((match = mdImgRegex.exec(content)) !== null) {
    mdImages.push({ full: match[0], alt: match[1], url: match[2] });
  }

  let imgIndex = 1;
  for (const item of mdImages) {
    if (item.url.startsWith('http://') || item.url.startsWith('https://')) {
      continue; // 网络图片保留
    }

    const localImgPath = findImageInVault(item.url, noteDir);
    if (localImgPath) {
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      const ext = path.extname(localImgPath) || '.png';
      const destName = `img-${imgIndex++}${ext}`;
      const destPath = path.join(targetDir, destName);

      fs.copyFileSync(localImgPath, destPath);
      const webPath = `/images/posts/${slug}/${destName}`;
      updatedContent = updatedContent.replace(item.full, `![${item.alt}](${webPath})`);
      console.log(`  🖼️ 已提取并同步图片: ${destName}`);
    } else {
      console.warn(`  ⚠️ 未在知识库中找到图片: ${item.url}`);
    }
  }

  // 2. Obsidian WikiEmbed 图片: ![[image.png]]
  const wikiImgRegex = /!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
  const wikiImages = [];
  while ((match = wikiImgRegex.exec(updatedContent)) !== null) {
    wikiImages.push({ full: match[0], file: match[1].trim(), alt: (match[2] || '').trim() });
  }

  for (const item of wikiImages) {
    const localImgPath = findImageInVault(item.file, noteDir);
    if (localImgPath) {
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      const ext = path.extname(localImgPath) || '.png';
      const destName = `img-${imgIndex++}${ext}`;
      const destPath = path.join(targetDir, destName);

      fs.copyFileSync(localImgPath, destPath);
      const webPath = `/images/posts/${slug}/${destName}`;
      const altText = item.alt || item.file;
      updatedContent = updatedContent.replace(item.full, `![${altText}](${webPath})`);
      console.log(`  🖼️ 已提取并转换 Wiki 图片: ${destName}`);
    }
  }

  return updatedContent;
}

// 清理 Obsidian WikiLinks: [[note|display]] -> display, [[note]] -> note
function cleanWikiLinks(content) {
  return content.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, p1, p2) => {
    return p2 ? p2 : p1;
  });
}

// 主同步流程
async function syncObsidianPosts() {
  const allFiles = scanVaultMarkdownFiles(vaultPath);
  console.log(`🔍 共扫描 Obsidian 库中 ${allFiles.length} 篇 Markdown 笔记...`);

  const activeSlugs = new Set();
  let publishCount = 0;

  for (const filePath of allFiles) {
    const rawContent = fs.readFileSync(filePath, 'utf-8');
    const { hasFm, fm, body } = parseFrontmatter(rawContent);

    if (!hasFm || !isPostPublished(fm)) {
      continue;
    }

    publishCount++;

    // 1. 获取标题
    let title = fm.title || '';
    if (!title) {
      const h1Match = body.match(/^#\s+(.+)$/m);
      if (h1Match) title = h1Match[1].trim();
      else title = path.basename(filePath, '.md');
    }

    // 2. 获取 Slug
    let slug = fm.slug || slugify(title);
    if (!slug || slug === 'post') {
      slug = `post-${slugify(path.basename(filePath, '.md'))}`;
    }

    console.log(`\n📄 [${publishCount}] 检测到勾选发布文章: 「${title}」`);

    // 3. 获取日期
    const dateStr = fm.date || fm.created;
    let isoDate;
    if (dateStr) {
      isoDate = formatIsoDate(dateStr);
    } else {
      const stat = fs.statSync(filePath);
      isoDate = formatIsoDate(stat.birthtime || stat.mtime);
    }

    // 4. 获取标签
    let tags = [];
    if (fm.tags) {
      try {
        if (fm.tags.startsWith('[') && fm.tags.endsWith(']')) {
          tags = JSON.parse(fm.tags);
        } else {
          tags = fm.tags.split(/[,，]/).map(t => t.trim()).filter(Boolean);
        }
      } catch {
        tags = fm.tags.split(/[,，]/).map(t => t.trim()).filter(Boolean);
      }
    }
    if (tags.length === 0) tags = ['随想'];

    // 5. 获取描述
    let description = fm.description || fm.summary || '';
    let processedBody = body;

    // 如果正文第一行是重复的 # 标题，移除之（Hugo 母版已有 h1）
    processedBody = processedBody.replace(new RegExp(`^#\\s+${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\r?\\n`, 'i'), '');

    if (!description) {
      description = processedBody
        .replace(/[#*`_\[\]()!\n\r]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 100);
      if (!description) description = title;
    }

    // 6. 处理正文图片与双向链接
    processedBody = processImages(processedBody, path.dirname(filePath), slug);
    processedBody = cleanWikiLinks(processedBody);

    // 7. 组装标准 Hugo Frontmatter
    const tagsYaml = tags.map(t => JSON.stringify(t)).join(', ');
    const safeTitle = title.replace(/"/g, '\\"');
    const safeDesc = description.replace(/"/g, '\\"');

    const finalMarkdown = `---
title: "${safeTitle}"
date: ${isoDate}
draft: false
tags: [${tagsYaml}]
description: "${safeDesc}"
---

${processedBody.trim()}
`;

    if (!fs.existsSync(postsDir)) {
      fs.mkdirSync(postsDir, { recursive: true });
    }

    const targetPostPath = path.join(postsDir, `${slug}.md`);
    fs.writeFileSync(targetPostPath, finalMarkdown, 'utf-8');
    activeSlugs.add(`${slug}.md`);
    console.log(`  ✅ 已同步至站点: content/posts/${slug}.md`);
  }

  // 8. 自动下架：如果已发布文章去勾，自动清理下架
  console.log('\n🧹 正在检查是否有需要自动下架的过期文章...');
  if (fs.existsSync(postsDir)) {
    const currentFiles = fs.readdirSync(postsDir);
    for (const f of currentFiles) {
      // 保留默认文章和栏目索引
      if (f === 'why-build-this-website.md' || f.startsWith('_index')) continue;

      if (!activeSlugs.has(f)) {
        console.log(`  🗑️ 检测到文章 [${f}] 在 Obsidian 中已取消发布勾选，执行下架删除。`);
        fs.unlinkSync(path.join(postsDir, f));

        // 清理对应的静态图片目录
        const slugName = path.basename(f, '.md');
        const imgDir = path.join(staticImagesDir, slugName);
        if (fs.existsSync(imgDir)) {
          fs.rmSync(imgDir, { recursive: true, force: true });
          console.log(`  🧹 已清理对应图片目录: static/images/posts/${slugName}`);
        }
      }
    }
  }

  console.log('====================================================');
  console.log(`🎉 Obsidian 文章同步完成！`);
  console.log(`📊 当前已发布上线文章数: ${activeSlugs.size} 篇`);
  console.log('====================================================\n');
}

syncObsidianPosts().catch(err => {
  console.error('❌ 同步过程中发生致命错误:', err);
  process.exit(1);
});
