import { execSync } from 'node:child_process';
import { event, fetchAllPrFiles, gh, openaiJson, postIssueComment, repo } from './common.mjs';

const marker = '<!-- yuna-comment-handler -->';

function parseCommand(body = '') {
  const text = body.trim();
  if (text.startsWith('/yuna validate')) return { mode: 'validate', payload: text.replace('/yuna validate', '').trim() };
  if (text.startsWith('/yuna fix')) return { mode: 'fix', payload: text.replace('/yuna fix', '').trim() };
  if (text.startsWith('/yuna re-review')) return { mode: 'validate', payload: 'PR 전체 재검토' };
  return null;
}

function safePatchBlocks(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((x) => ({ file: x?.file || x?.path || '', patch: x?.patch || '' }))
    .filter((x) => x.file && x.patch && x.patch.includes('@@'))
    .slice(0, 3);
}

async function run() {
  const issue = event.issue;
  const comment = event.comment;
  if (!issue?.pull_request) return;

  const allowedUser = (process.env.YUNA_ALLOWED_USER || '').trim();
  if (allowedUser && comment.user?.login !== allowedUser) return;

  const cmd = parseCommand(comment.body || '');
  if (!cmd) return;

  const prNumber = issue.number;
  const pr = await gh(`/repos/${repo}/pulls/${prNumber}`);
  const files = await fetchAllPrFiles(prNumber);
  const filesForPrompt = files.slice(0, 25).map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch || '',
  }));

  let result;
  try {
    result = await openaiJson({
      system:
        'You are Yuna. Evaluate whether a PR comment is valid based on the code diff. Reply in Korean JSON keys: verdict(valid|partially_valid|invalid), confidence(0-100), reasoning, suggested_reply, patches(array of {file,patch unified diff}) when mode=fix and a concrete code change is possible.',
      user: JSON.stringify({
        mode: cmd.mode,
        commenter: comment.user?.login,
        commandPayload: cmd.payload,
        prTitle: pr.title,
        prBody: pr.body || '',
        changedFiles: filesForPrompt,
      }),
    });
  } catch (err) {
    await postIssueComment(prNumber, `${marker}\n⚠️ 평가 실패: ${err.message}`);
    return;
  }

  const lines = [];
  lines.push(marker);
  lines.push(`@${comment.user?.login} 요청 검토 결과`);
  lines.push(`- Verdict: **${result.verdict || 'partially_valid'}**`);
  lines.push(`- Confidence: **${result.confidence ?? 0}%**`);
  lines.push(`- 판단 근거: ${result.reasoning || '근거 없음'}`);
  if (result.suggested_reply) lines.push(`- 제안: ${result.suggested_reply}`);

  const patchBlocks = cmd.mode === 'fix' ? safePatchBlocks(result.patches) : [];

  if (cmd.mode === 'fix' && patchBlocks.length) {
    try {
      for (const [idx, p] of patchBlocks.entries()) {
        const patchFile = `.yuna-patch-${idx}.diff`;
        execSync(`cat > ${patchFile} <<'PATCH'\n${p.patch}\nPATCH`);
        execSync(`git apply --index --whitespace=fix ${patchFile}`);
      }

      const changed = execSync('git diff --cached --name-only', { encoding: 'utf8' }).trim();
      if (!changed) {
        lines.push('- 수정 시도: 적용 가능한 패치가 없어 커밋하지 않았습니다.');
      } else {
        execSync('git config user.name "yuna-bot"');
        execSync('git config user.email "yuna-bot@users.noreply.github.com"');
        execSync(`git commit -m "chore(yuna): apply feedback from @${comment.user?.login}"`);

        // push to PR head branch (same-repo PR expected)
        const headRef = pr.head?.ref;
        execSync(`git push origin HEAD:${headRef}`);
        lines.push(`- 수정 반영: \`${changed.replace(/\n/g, ', ')}\``);
      }
    } catch (err) {
      lines.push(`- 수정 실패: ${err.message}`);
    }
  } else if (cmd.mode === 'fix') {
    lines.push('- 수정 시도: 모델이 적용 가능한 unified diff를 생성하지 못해 자동 수정을 건너뛰었습니다.');
  }

  lines.push('\n사용법: `/yuna validate <의견>` 또는 `/yuna fix <수정요청>`');

  await postIssueComment(prNumber, lines.join('\n'));
}

run().catch(async (err) => {
  console.error(err);
  const issue = event.issue;
  if (issue?.number) {
    await postIssueComment(issue.number, `${marker}\n⚠️ 코멘트 처리 예외: ${err.message}`);
  }
  process.exit(1);
});
