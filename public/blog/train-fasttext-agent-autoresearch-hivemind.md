# Train FastText: 一个 agent-autoresearch-hivemind 案例

## 结论先行

这个任务表面上是训练 Yelp fastText 分类器，实际考的是 agent 是否能同时管理两个约束：`P@1 >= 0.62` 和 `/app/model.bin < 150MB`。所有认真展开搜索的 agent 最后都会趋同到同一个解法骨架：把 parquet 转成 `__label__` 文本，训练 supervised fastText，再围绕 n-gram、embedding 维度、bucket 和 quantization 做大小-精度折中。

真正的分叉不在“知不知道 fastText”，而在优化顺序。Oracle 直接命中：

```bash
fasttext supervised -input /app/data/train.txt -output model -wordNgrams 2 -dim 5
```

它用 `wordNgrams=2` 保留 Yelp 情感分类最有效的局部词组特征，同时把 `dim` 压到 5。这个选择看起来很小，但对同分布 Yelp、0.62 门槛、150MB 上限来说正好够用。

## 为什么人类专家更容易想到 oracle

人类专家会先看绑定约束：模型大小。fastText 的模型大小近似随 `dim` 和 hash bucket 规模增长，所以 `dim` 是最直接的大小旋钮。Yelp full-review 五分类在同分布测试上并不需要很强的语义 embedding；很多信号来自 unigram/bigram 的线性分类边界。因此专家会先问：“最低维度能不能过线？”

GPT-5.5 这类 agent 的默认路线更像现代 ML 工程师：先训练一个较强模型，确认 P@1，再压缩。我们本机 Host Codex/GPT-5.5 的有效轨迹最终用了 `wordNgrams=3`、`dim=100`、`bucket=4M`、字符 n-gram 和 quantization，得到 124,531,872 bytes，补充私有验证 `P@1=0.622`。它成功闭环，但路线比 oracle 长很多。

## 统计特征

- 已纳入轨迹数：25
- artifact-valid / passed 轨迹数：1
- 轨迹里明确触达 fastText：25
- 明确做 parquet 到 FastText 格式转换：24
- 明确训练 supervised fastText：16
- 明确使用 quantization：11
- 观测到的最高公开或补充 `P@1`：0.708

## 本地 SSD 三条补充轨迹

| Run | Started | Outcome | Verifier P@1 | Takeaway |
| --- | --- | --- | ---: | --- |
| Host Codex / GPT-5.5 | 2026-06-03 13:09 | artifact-valid | 0.622 | Closed the validation loop: public P@1=0.628, supplemental private-distribution P@1=0.622, final artifact under 150 MiB. |
| Claude Code / Kimi K2.6 | 2026-05-28 05:34 | private near-miss | 0.617 | Completed the task flow and produced /app/model.bin, but the official private verifier landed just below threshold at P@1=0.617. |
| Claude Code / Kimi K2.5 | 2026-05-28 04:05 | timeout/no artifact | — | Timed out before final artifact creation; verifier could not open /app/model.bin. |

## 聚类结果

| Cluster | Count | Interpretation |
| --- | ---: | --- |
| Exploratory tooling failure | 11 | The trajectory spent most work on environment, package, or data handling rather than the size-accuracy frontier. |
| Uncompressed or size-blind fastText | 5 | The run trained supervised fastText but did not close the model-size constraint early enough. |
| Accuracy near miss | 3 | The run pursued the right classifier family and got close on P@1, but its threshold/size/verification closure was incomplete. |
| Compressed n-gram near miss | 3 | The run used quantization/ngrams and saw plausible validation numbers, but did not land a clean final verified artifact. |
| Agent bootstrap failure | 1 | The harness or agent command failed before meaningful task search. |
| Validated closed-loop artifact | 1 | The agent trained, measured, compressed, promoted /app/model.bin, and rechecked size/accuracy. This is the best agent-derived trajectory for positive RL signal. |
| Valid or near-valid, but timed out | 1 | The run found the right fastText ingredients but spent too long in training, quantization, or cleanup, so the official harness timed out. |

## 对 RL 数据的启发

最干净的偏好信号不是“谁写出了看起来合理的 fastText 命令”，而是谁完成了验证闭环。好的轨迹有三个稳定特征：反复测 `P@1`，反复测 byte size，把最终 artifact 放到 `/app/model.bin` 后再次验证。差轨迹往往也知道 fastText，但缺少最后一轮收口，或者把大模型训练、包安装、autotune、quantization 放在过长链条里，导致 timeout。

因此这个 case 的 preference pair 可以这样组织：Host Codex/GPT-5.5 的 closed-loop run 作为正例；同样识别了 fastText 但没有稳定 artifact closure 的 near-miss 作为 hard negative；纯 harness/bootstrap failure 则不适合作为普通建模能力负例。

## Hivemind insight

“所有 agent 都趋同的解法”不是同一个命令，而是同一个研究程序：数据格式转换、supervised fastText、约束驱动压缩、验证闭环。Oracle 的价值在于展示了一个更短的专家路径：先压维度，再用 bigram 补足最低必要性能。
