import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

console.log('==============================================');
console.log('  Folio 个人数字空间 · 自动化同步发布系统');
console.log('==============================================\n');

try {
  // 1. 同步 Obsidian
  console.log('[1/3] 正在扫描 Obsidian 知识库并同步已勾选文章...');
  execSync('node scripts/sync-obsidian.mjs', { cwd: rootDir, stdio: 'inherit' });

  // 2. 自动化回归测试
  console.log('\n[2/3] 正在执行全量自动化回归测试 (npm test)...');
  execSync('npm test', { cwd: rootDir, stdio: 'inherit' });

  // 3. Git 检查与提交推送
  console.log('\n[3/3] 正在检查内容变更并推送到云端...');
  execSync('git add content/posts static/images/posts', { cwd: rootDir });

  let hasChanges = false;
  try {
    execSync('git diff --cached --quiet', { cwd: rootDir });
  } catch {
    hasChanges = true;
  }

  if (hasChanges) {
    execSync('git commit -m "feat(blog): sync published posts from obsidian"', { cwd: rootDir, stdio: 'inherit' });
    console.log('\n🚀 正在推送到 GitHub 远端仓库 (触发 Cloudflare & GitHub Pages 自动构建)...');
    execSync('git push origin main main:master', { cwd: rootDir, stdio: 'inherit' });
    console.log('\n==============================================');
    console.log('  [OK] 同步完成！文章已成功推送到 GitHub！');
    console.log('  约 20-30 秒后线上网站自动更新生效。');
    console.log('==============================================');
  } else {
    console.log('ℹ️ content/posts 无新变动。');
    try {
      execSync('gh workflow run deploy.yml --repo illtree/my-site', { cwd: rootDir });
      console.log('  [OK] 已触发云端部署任务。');
    } catch {}
  }
} catch (err) {
  console.error('\n❌ 发布流程中断:', err.message);
  process.exit(1);
}
