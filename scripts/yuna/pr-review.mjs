import { event, fetchAllPrFiles, gh, openaiJson, postIssueComment, repo } from './common.mjs';

const marker = '<!-- yuna-pr-review -->';

async function run() {
  const pr = event.pull_request;
  if (!pr) return;
  if (pr.draft) return;

  const prNumber = pr.number;
  const files = await fetchAllPrFiles(prNumber);
  const maxFiles = Number(process.env.YUNA_REVIEW_MAX_FILES || 25);

  const filesForPrompt = files.slice(0, maxFiles).map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch || '',
  }));

  let review;
  try {
    review = await openaiJson({
      system:
        'You are Yuna, a strict but practical code reviewer. Reply in Korean. Return JSON with keys: summary, positives(array), risks(array), suggestions(array), verdict(one of approve|changes_requested|comment_only). Keep suggestions concrete and scoped to actual diff.',
      user: JSON.stringify({
        title: pr.title,
        body: pr.body || '',
        changedFiles: files.length,
        files: filesForPrompt,
      }),
    });
  } catch (err) {
    await postIssueComment(
      prNumber,
      `${marker}\n⚠️ Yuna 리뷰 실패: ${err.message}\n- OPENAI_API_KEY/모델 설정을 확인해주세요.`
    );
    return;
  }

  const lines = [];
  lines.push(marker);
  lines.push('## 유나 자동 PR 리뷰');
  lines.push(`- Verdict: **${review.verdict || 'comment_only'}**`);
  lines.push(`- Summary: ${review.summary || '요약 없음'}`);

  if (Array.isArray(review.positives) && review.positives.length) {
    lines.push('\n### 좋았던 점');
    for (const p of review.positives.slice(0, 5)) lines.push(`- ${p}`);
  }

  if (Array.isArray(review.risks) && review.risks.length) {
    lines.push('\n### 리스크');
    for (const r of review.risks.slice(0, 8)) lines.push(`- ${r}`);
  }

  if (Array.isArray(review.suggestions) && review.suggestions.length) {
    lines.push('\n### 제안');
    for (const s of review.suggestions.slice(0, 8)) lines.push(`- ${s}`);
  }

  lines.push('\n명령어: `/yuna validate ...` 또는 `/yuna fix ...` 로 후속 검토/수정 요청 가능');

  await postIssueComment(prNumber, lines.join('\n'));
}

run().catch(async (err) => {
  console.error(err);
  const pr = event.pull_request;
  if (pr?.number) {
    await postIssueComment(pr.number, `${marker}\n⚠️ 리뷰 워크플로우 예외: ${err.message}`);
  }
  process.exit(1);
});
