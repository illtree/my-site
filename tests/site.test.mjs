import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const contentDir = path.join(rootDir, 'content');

describe('Folio 个人数字空间工程自动化测试套件', () => {

  before(() => {
    // 确保在测试前执行全量构建
    execSync('hugo', { cwd: rootDir, stdio: 'pipe', encoding: 'utf-8' });
  });

  test('1. Hugo 生产构建无报错且速度在性能基线内 (<1000ms)', () => {
    const start = Date.now();
    const buildOutput = execSync('hugo', { cwd: rootDir, encoding: 'utf-8' });
    const duration = Date.now() - start;

    assert.match(buildOutput, /Total in \d+ ms/, 'Hugo 构建应当输出完成耗时');
    assert.doesNotMatch(buildOutput, /ERROR/, '构建输出中不得包含 ERROR');
    assert.ok(duration < 3000, `构建耗时需小于 3000ms，当前为 ${duration}ms`);
  });

  test('2. 核心页面生成完整性校验', () => {
    const coreFiles = [
      'index.html',
      'posts/index.html',
      'projects/index.html',
      'artworks/index.html',
      'about/index.html',
      'css/style.css'
    ];

    for (const relPath of coreFiles) {
      const fullPath = path.join(publicDir, relPath);
      assert.ok(fs.existsSync(fullPath), `核心输出文件必须存在: ${relPath}`);
      const stat = fs.statSync(fullPath);
      assert.ok(stat.size > 0, `文件不可为空: ${relPath} (当前大小: ${stat.size} 字节)`);
    }
  });

  test('3. Markdown 内容源文件与 Frontmatter 元数据规范校验', () => {
    function getMdFiles(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      let files = [];
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files = files.concat(getMdFiles(full));
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          files.push(full);
        }
      }
      return files;
    }

    const mdFiles = getMdFiles(contentDir);
    assert.ok(mdFiles.length >= 4, '必须包含基础内容与栏目');

    const validStatuses = new Set([
      '原型阶段', '原型设计', '进行中', '开发中', '已上线', '概念构思', '机制重塑中', '验证中', '迭代中', '作品集', '个人项目'
    ]);

    for (const file of mdFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      const rel = path.relative(rootDir, file);
      const isSectionIndex = path.basename(file).startsWith('_index');

      // 提取 frontmatter
      const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      assert.ok(match, `文件必须具备合法的 YAML frontmatter: ${rel}`);
      const fm = match[1];

      // title 必须非空
      assert.match(fm, /title:\s*["'].+["']/, `${rel} 必须包含非空 title`);

      // 仅普通页面强制校验 date 格式
      if (!isSectionIndex) {
        assert.match(fm, /date:\s*\d{4}-\d{2}-\d{2}/, `${rel} 必须包含合法的 ISO 日期`);
      }

      // 项目常规页面必须包含合法的 status
      if (file.includes('projects') && !isSectionIndex) {
        const statusMatch = fm.match(/status:\s*["']([^"']+)["']/);
        assert.ok(statusMatch, `项目必须配置 status 字段: ${rel}`);
        const statusVal = statusMatch[1];
        assert.ok(validStatuses.has(statusVal), `项目 status [${statusVal}] 不在允许枚举值中: ${rel}`);
      }

      // description 或 summary 必须存在
      assert.match(fm, /(description|summary):/, `${rel} 必须包含简介描述字段`);
    }
  });

  test('4. 首页语义结构与导航链路校验', () => {
    const indexPath = path.join(publicDir, 'index.html');
    const html = fs.readFileSync(indexPath, 'utf-8');

    // 品牌标题与卡片网格
    assert.ok(html.includes('Folio'), '首页必须包含站点主品牌 Folio');
    assert.ok(html.includes('card-grid'), '首页必须包含卡片网格容器');
    assert.ok(html.includes('entry-card'), '首页必须渲染入口卡片');

    // 快捷入口 Dock (Footer)
    assert.ok(html.includes('footer-icon-dock'), '底部必须包含快捷入口图标 Dock');
    assert.ok(html.includes('href="/posts/"'), 'Dock 必须包含文章入口');
    assert.ok(html.includes('href="/projects/"'), 'Dock 必须包含项目入口');
    assert.ok(html.includes('href="/about/"'), 'Dock 必须包含关于与联络入口');

    // 关于页与联络功能校验
    const aboutPath = path.join(publicDir, 'about', 'index.html');
    const aboutHtml = fs.readFileSync(aboutPath, 'utf-8');
    assert.ok(aboutHtml.includes('alwaysyys@hotmail.com'), '关于页必须包含作者邮箱');
    assert.ok(aboutHtml.includes('E-Mail：'), '关于页必须包含 E-Mail 前缀');

    // 主题切换器
    assert.ok(html.includes('id="theme-toggle"'), '必须包含深色/浅色主题切换按钮');

    // 项目卡片与状态标签
    assert.ok(html.includes('来约场球'), '首页必须展示来约场球卡片');
    assert.ok(html.includes('card-status'), '卡片必须渲染状态信息');
  });

  test('5. 站内无死链（Dead Links）全量排查', () => {
    function getAllHtmlFiles(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      let files = [];
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files = files.concat(getAllHtmlFiles(full));
        } else if (entry.isFile() && entry.name.endsWith('.html')) {
          files.push(full);
        }
      }
      return files;
    }

    const htmlFiles = getAllHtmlFiles(publicDir);
    const linkRegex = /href=["']([^"']+)["']/g;

    for (const file of htmlFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      let match;
      while ((match = linkRegex.exec(content)) !== null) {
        const href = match[1];

        // 忽略外部链接、纯锚点、javascript、mailto
        if (
          href.startsWith('http://') ||
          href.startsWith('https://') ||
          href.startsWith('//') ||
          href.startsWith('#') ||
          href.startsWith('mailto:') ||
          href.startsWith('tel:') ||
          href.startsWith('data:')
        ) {
          continue;
        }

        // 规范化内部链接，注意 decode 避免中文标签在 Windows 路径不匹配
        const rawPath = href.split('#')[0].split('?')[0];
        if (!rawPath) continue;
        const cleanHref = decodeURIComponent(rawPath);

        let targetFile;
        if (cleanHref.endsWith('/')) {
          targetFile = path.join(publicDir, cleanHref, 'index.html');
        } else if (path.extname(cleanHref) === '') {
          targetFile = path.join(publicDir, cleanHref, 'index.html');
        } else {
          targetFile = path.join(publicDir, cleanHref);
        }

        assert.ok(
          fs.existsSync(targetFile),
          `检测到死链: 在 [${path.relative(publicDir, file)}] 中引用的 [${href}] 对应文件 [${path.relative(publicDir, targetFile)}] 不存在！`
        );
      }
    }
  });

  test('6. 样式契约与暗色模式 (Dark Mode) 支持', () => {
    const cssPath = path.join(publicDir, 'css', 'style.css');
    const css = fs.readFileSync(cssPath, 'utf-8');

    // 核心 CSS 变量契约
    const requiredVars = [
      '--page',
      '--card',
      '--ink',
      '--muted',
      '--quiet',
      '--line',
      '--accent'
    ];

    for (const v of requiredVars) {
      assert.ok(css.includes(v), `style.css 必须声明变量: ${v}`);
    }

    // 暗色模式契约
    assert.ok(css.includes('[data-theme="dark"]'), '必须包含 [data-theme="dark"] 手动切换覆盖样式');
    assert.ok(css.includes('(prefers-color-scheme: dark)'), '必须包含媒体查询自动适配系统深色设置');

    // 响应式移动端断点
    assert.ok(css.includes('@media (max-width:') || css.includes('@media (min-width:'), '必须包含响应式断点适配');
  });

  test('7. 性能预算与安全零依赖契约', () => {
    const indexPath = path.join(publicDir, 'index.html');
    const html = fs.readFileSync(indexPath, 'utf-8');

    // 零外部 CDN / 外部脚本依赖
    assert.doesNotMatch(html, /<script[^>]+src=["']https?:\/\//, '严禁引入外部未授权 CDN 脚本');
    assert.doesNotMatch(html, /<link[^>]+href=["']https?:\/\/(?!fonts)/, '不得引入外部未知样式源');

    // 静态包体积预算（CSS 小于 50KB）
    const cssStat = fs.statSync(path.join(publicDir, 'css', 'style.css'));
    assert.ok(cssStat.size < 50 * 1024, `CSS 文件体积需小于 50KB，当前为 ${(cssStat.size / 1024).toFixed(2)} KB`);
  });

  test('8. Obsidian 勾选发布引擎与工作流契约', () => {
    const syncScript = path.join(rootDir, 'scripts', 'sync-obsidian.mjs');
    assert.ok(fs.existsSync(syncScript), '必须提供 scripts/sync-obsidian.mjs 同步脚本');

    const publishCmd = path.join(rootDir, 'publish-blog.cmd');
    assert.ok(fs.existsSync(publishCmd), '根目录必须提供 publish-blog.cmd 一键发布脚本');
    const cmdContent = fs.readFileSync(publishCmd, 'utf-8');
    assert.ok(cmdContent.includes('publish.mjs') || cmdContent.includes('sync-obsidian.mjs'), 'publish-blog.cmd 必须集成发布引擎');
    const publishScript = path.join(rootDir, 'scripts', 'publish.mjs');
    assert.ok(fs.existsSync(publishScript), '必须提供 scripts/publish.mjs 发布工作流');
    const pubContent = fs.readFileSync(publishScript, 'utf-8');
    assert.ok(pubContent.includes('npm test'), 'publish.mjs 必须在推送前执行自动化回归测试防呆');

    const pkgJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf-8'));
    assert.ok(pkgJson.scripts['sync:obsidian'], 'package.json 必须包含 sync:obsidian 命令');
  });

});
