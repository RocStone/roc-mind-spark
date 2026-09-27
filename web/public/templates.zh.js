/* ============================================================
   MindSpark — 内置模板的中文覆盖层。

   templates.js 里的英文 TEMPLATES 是结构的唯一来源（节点 k、parent、
   颜色、分组、连线、任务状态……）。这里只按「模板 id → 节点 k」覆盖
   name / desc 和每个节点的 text / notes（个别块节点还有 html），
   由 app.js 的 templateForLang() 在界面语言为中文时合并。

   加载顺序：templates.js 之后、app.js 之前（见 index.html）。
   新增或改动英文模板时，记得同步这里；web/test/templates-zh.test.mjs
   会检查每个模板、每个节点 k 都有中文。
   ============================================================ */

const TEMPLATES_ZH = {
  /* ===== AI 与智能体 ===== */
  agent_architecture: {
    name:'AI 智能体架构', desc:'拆解单个智能体：模型、记忆、规划、工具、控制循环与护栏',
    nodes:{
      root:{ text:'AI 智能体架构', notes:'<p>拆解单个 AI 智能体：核心是模型，此外还有它记住什么、如何规划、能调用哪些工具，以及让它不跑偏的控制循环与护栏。</p>' },
      model:{ text:'模型（LLM 核心）' },
      m1:{ text:'推理引擎' },
      m2:{ text:'模型选型（能力 vs 成本）' },
      m3:{ text:'上下文窗口' },
      m4:{ text:'系统提示词（System prompt）' },
      memory:{ text:'记忆' },
      mem1:{ text:'短期记忆（草稿区）' },
      mem2:{ text:'长期记忆（向量库）' },
      mem3:{ text:'情景记忆' },
      mem4:{ text:'工作状态' },
      plan:{ text:'规划' },
      p1:{ text:'任务拆解' },
      p2:{ text:'ReAct（推理 + 行动）' },
      p3:{ text:'思维链（Chain-of-thought）' },
      p4:{ text:'反思 / 自我批评' },
      p5:{ text:'重新规划' },
      tools:{ text:'工具 / 行动' },
      t1:{ text:'函数调用（Function calling）' },
      t2:{ text:'外部 API' },
      t3:{ text:'代码执行' },
      t4:{ text:'网页搜索 / 检索' },
      t5:{ text:'MCP 服务器' },
      loop:{ text:'控制循环' },
      l1:{ text:'观察 → 推理 → 行动' },
      l2:{ text:'停止条件' },
      l3:{ text:'重试 / 错误处理' },
      guard:{ text:'护栏' },
      g1:{ text:'输入校验' },
      g2:{ text:'输出检查' },
      g3:{ text:'人工介入（Human-in-the-loop）' },
      g4:{ text:'成本 / 速率限制' },
      out:{ text:'输出' },
      o1:{ text:'最终回复' },
      o2:{ text:'结构化输出' },
      o3:{ text:'副作用（写入、调用）' }
    }
  },
  agentic_patterns: {
    name:'智能体工作流模式', desc:'从增强型 LLM 到自主智能体，以及如何在其间取舍',
    nodes:{
      root:{ text:'智能体工作流模式', notes:'<p>构建智能体系统的常见模式，从单个增强型 LLM 一直到自主智能体，以及如何在其间取舍。经验法则：优先选<strong>能解决问题的最简单模式</strong>。</p>' },
      aug:{ text:'增强型 LLM（基础）' },
      au1:{ text:'检索' },
      au2:{ text:'工具' },
      au3:{ text:'记忆' },
      chain:{ text:'提示链（Prompt chaining）' },
      c1:{ text:'顺序执行各步骤' },
      c2:{ text:'步骤之间设检查关卡' },
      route:{ text:'路由' },
      r1:{ text:'对输入分类' },
      r2:{ text:'分发到专门的处理路径' },
      par:{ text:'并行化' },
      pa1:{ text:'分段（拆分工作）' },
      pa2:{ text:'投票（跑 N 次再汇总）' },
      orch:{ text:'编排者–执行者' },
      or1:{ text:'动态生成子任务' },
      or2:{ text:'汇总结果' },
      evo:{ text:'评估者–优化者' },
      e1:{ text:'生成' },
      e2:{ text:'评审' },
      e3:{ text:'改进（循环）' },
      auto:{ text:'自主智能体' },
      at1:{ text:'开放式循环' },
      at2:{ text:'调用工具' },
      at3:{ text:'人工检查点' },
      choose:{ text:'如何选择模式' },
      ch1:{ text:'复杂度 vs 成本 vs 延迟' },
      ch2:{ text:'优先用能解决问题的最简单方案' }
    }
  },
  claude_skill: {
    name:'Claude Agent Skill 技能', desc:'搭一个 SKILL.md 骨架：Claude 在处理特定任务时按需加载的指令',
    nodes:{
      root:{ text:'我的 Skill 名称', notes:'<p><strong>Skill</strong> 是一个包含 <code>SKILL.md</code> 文件的文件夹，用来教 Claude 以可复用的方式完成某项特定任务，比如遵循你的品牌规范，或你们团队的特定工作流。下面的 YAML 块是这个文件必需的 frontmatter，可以像编辑其他节点一样编辑它的表格。参见 <a href="https://github.com/anthropics/skills" target="_blank" rel="noopener noreferrer">github.com/anthropics/skills</a>。</p>' },
      // YAML 键（name / description）和 name 的取值是文件格式的一部分，保持英文。
      fm:{ text:'', html:'<table><thead><tr><th>字段</th><th>值</th></tr></thead><tbody><tr><td>name</td><td>my-skill-name</td></tr><tr><td>description</td><td>清楚说明这个 Skill 做什么、什么时候该用它</td></tr></tbody></table>' },
      instr:{ text:'在这里写下 Skill 启用时 Claude 要遵循的指令' },
      ex:{ text:'示例' },
      ex1:{ text:'用法示例 1' },
      ex2:{ text:'用法示例 2' },
      gl:{ text:'准则' },
      gl1:{ text:'准则 1' },
      gl2:{ text:'准则 2' }
    }
  },

  /* ===== 提示词工程 ===== */
  rtcce: {
    name:'角色 / 任务 / 背景 / 约束 / 示例', desc:'经典结构化提示词，最常用的基本型',
    nodes:{
      root:{ text:'提示词：[你的任务]' },
      r:{ text:'角色' },
      r1:{ text:'你是一名资深……' },
      t:{ text:'任务' },
      t1:{ text:'[描述要做什么]' },
      c:{ text:'背景' },
      c1:{ text:'[背景信息]' },
      cn:{ text:'约束' },
      cn1:{ text:'[要避免什么 / 格式要求]' },
      e:{ text:'示例' },
      e1:{ text:'[输入 / 期望输出]' }
    }
  },
  cot: {
    name:'思维链（Chain-of-Thought）', desc:'引导逐步推理的提示词',
    nodes:{
      root:{ text:'推理提示词' },
      q:{ text:'问题' },
      q1:{ text:'[要解决的问题]' },
      a:{ text:'思路' },
      a1:{ text:'一步一步地思考。' },
      a2:{ text:'找出其中的子问题。' },
      a3:{ text:'按顺序逐个解决子问题。' },
      a4:{ text:'综合得出最终答案。' },
      o:{ text:'输出格式' },
      o1:{ text:'先展示推理过程，再把最终答案放进 <answer> 标签。' }
    }
  },
  fc: {
    name:'函数调用 schema', desc:'工具 / 函数定义大纲',
    nodes:{
      // 函数名、参数名、类型名是代码标识符，保持英文。
      root:{ text:'function_name' },
      d:{ text:'说明' },
      d1:{ text:'[这个函数做什么、何时调用]' },
      p:{ text:'参数' },
      p1:{ text:'param_a（string，必填）' },
      p2:{ text:'param_b（number，可选）' },
      p3:{ text:'param_c（enum，可选值：a | b | c）' },
      r:{ text:'返回值' },
      r1:{ text:'[返回值的结构]' },
      e:{ text:'错误情况' },
      e1:{ text:'[什么时候失败、返回什么]' }
    }
  },
  fewshot: {
    name:'少样本示例（Few-shot）', desc:'用示例示范模式的提示词',
    nodes:{
      root:{ text:'Few-shot 提示词' },
      i:{ text:'指令' },
      i1:{ text:'[做什么、格式、语气]' },
      x1:{ text:'示例 1' },
      x1a:{ text:'输入：……' },
      x1b:{ text:'输出：……' },
      x2:{ text:'示例 2' },
      x2a:{ text:'输入：……' },
      x2b:{ text:'输出：……' },
      q:{ text:'轮到你了' },
      q1:{ text:'输入：[你的真实输入]' }
    }
  },

  /* ===== 研究与写作 ===== */
  imrad: {
    name:'研究论文（IMRaD）', desc:'标准实证论文骨架',
    nodes:{
      root:{ text:'论文标题' },
      ab:{ text:'摘要' },
      ab1:{ text:'背景' },
      ab2:{ text:'方法' },
      ab3:{ text:'结果' },
      ab4:{ text:'结论' },
      in:{ text:'引言' },
      in1:{ text:'问题与动机' },
      in2:{ text:'文献空白' },
      in3:{ text:'本文贡献' },
      in4:{ text:'全文结构' },
      rw:{ text:'相关工作' },
      rw1:{ text:'主题 A' },
      rw2:{ text:'主题 B' },
      rw3:{ text:'我们的不同之处' },
      me:{ text:'研究方法' },
      me1:{ text:'实验设置' },
      me2:{ text:'数据 / 数据集' },
      me3:{ text:'方法' },
      me4:{ text:'基线' },
      re:{ text:'结果' },
      re1:{ text:'主要发现' },
      re2:{ text:'图表' },
      re3:{ text:'消融实验' },
      di:{ text:'讨论' },
      di1:{ text:'结果解读' },
      di2:{ text:'与已有工作的比较' },
      di3:{ text:'局限性' },
      co:{ text:'结论' },
      co1:{ text:'总结' },
      co2:{ text:'未来工作' },
      rf:{ text:'参考文献' }
    }
  },
  rebuttal: {
    name:'审稿回复 / Rebuttal', desc:'论文修改时逐条回复审稿意见',
    nodes:{
      root:{ text:'致审稿人的回复' },
      su:{ text:'修改概要' },
      r1:{ text:'审稿人 1' },
      r1a:{ text:'意见 1' },
      r1a1:{ text:'回复' },
      r1a2:{ text:'对应修改 →' },
      r1b:{ text:'意见 2' },
      r1b1:{ text:'回复' },
      r2:{ text:'审稿人 2' },
      r2a:{ text:'意见 1' },
      r2a1:{ text:'回复' },
      r3:{ text:'审稿人 3' },
      r3a:{ text:'意见 1' },
      r3a1:{ text:'回复' },
      ne:{ text:'新增实验' },
      op:{ text:'待解决事项' }
    }
  },
  litreview: {
    name:'文献综述梳理', desc:'把一堆论文整理成清晰的结构',
    nodes:{
      root:{ text:'主题' },
      se:{ text:'奠基性文献' },
      cl:{ text:'主题聚类' },
      cl1:{ text:'聚类 1：核心观点' },
      cl2:{ text:'聚类 2：核心观点' },
      cl3:{ text:'聚类 3：核心观点' },
      ml:{ text:'方法全景' },
      gp:{ text:'空白与开放问题' },
      cn:{ text:'领域内的矛盾结论' },
      po:{ text:'我的定位 / 贡献' }
    }
  },
  proposal: {
    name:'研究计划书', desc:'基金、奖学金申请或项目立项',
    nodes:{
      root:{ text:'研究计划' },
      ps:{ text:'问题陈述' },
      mo:{ text:'动机与意义' },
      rq:{ text:'研究问题 / 假设' },
      ob:{ text:'研究目标' },
      ob1:{ text:'目标 1' },
      ob2:{ text:'目标 2' },
      ob3:{ text:'目标 3' },
      me:{ text:'研究方法' },
      tl:{ text:'时间线与里程碑' },
      eo:{ text:'预期成果' },
      rk:{ text:'风险与应对' }
    }
  },
  experiment: {
    name:'实验设计', desc:'动手之前先把研究规划好',
    nodes:{
      root:{ text:'实验' },
      hy:{ text:'假设' },
      va:{ text:'变量' },
      va1:{ text:'自变量' },
      va2:{ text:'因变量' },
      va3:{ text:'控制变量' },
      st:{ text:'实验设置 / 器材' },
      pr:{ text:'实验步骤' },
      pr1:{ text:'步骤 1' },
      pr2:{ text:'步骤 2' },
      pr3:{ text:'步骤 3' },
      dc:{ text:'数据收集' },
      an:{ text:'分析计划' },
      tv:{ text:'效度威胁' }
    }
  },
  thesis: {
    name:'学位论文 / 多篇论文主线', desc:'几篇独立论文如何串成一篇学位论文',
    nodes:{
      root:{ text:'学位论文的核心贡献' },
      p1:{ text:'论文 1' },
      p1a:{ text:'研究问题' },
      p1b:{ text:'贡献' },
      p1c:{ text:'投稿去向与状态' },
      p2:{ text:'论文 2' },
      p2a:{ text:'研究问题' },
      p2b:{ text:'贡献' },
      p3:{ text:'论文 3' },
      p3a:{ text:'研究问题' },
      p3b:{ text:'贡献' },
      ct:{ text:'贯穿全文的主题' },
      gp:{ text:'尚待填补的空白' },
      ch:{ text:'学位论文章节对应' }
    }
  },
  prisma: {
    name:'系统综述（PRISMA）', desc:'基于正式筛选流程的综述',
    nodes:{
      root:{ text:'系统综述' },
      rq:{ text:'研究问题' },
      ss:{ text:'检索策略' },
      ss1:{ text:'数据库' },
      ss2:{ text:'检索词' },
      ss3:{ text:'时间范围' },
      ic:{ text:'纳入 / 排除标准' },
      sc:{ text:'筛选' },
      sc1:{ text:'检出' },
      sc2:{ text:'初筛' },
      sc3:{ text:'符合条件' },
      sc4:{ text:'最终纳入' },
      de:{ text:'数据提取字段' },
      sy:{ text:'综合分析' },
      qa:{ text:'质量评价' }
    }
  },
  talk: {
    name:'学术报告大纲', desc:'组织一场研究报告',
    nodes:{
      root:{ text:'报告标题' },
      ho:{ text:'开场抓手' },
      pr:{ text:'问题' },
      id:{ text:'一个核心想法' },
      rh:{ text:'结果亮点' },
      rh1:{ text:'结果 1' },
      rh2:{ text:'结果 2' },
      ta:{ text:'核心收获' },
      bk:{ text:'备用幻灯片' }
    }
  },
  finer: {
    name:'研究问题（FINER）', desc:'立题之前先把问题拷问一遍',
    nodes:{
      root:{ text:'研究问题' },
      f:{ text:'可行（Feasible）' },
      f1:{ text:'时间、数据、技能、经费够吗？' },
      i:{ text:'有趣（Interesting）' },
      i1:{ text:'领域内有人关心吗？' },
      n:{ text:'新颖（Novel）' },
      n1:{ text:'它带来了什么新东西？' },
      e:{ text:'合乎伦理（Ethical）' },
      e1:{ text:'审批 / 知情同意 / 风险？' },
      r:{ text:'相关（Relevant）' },
      r1:{ text:'对理论或实践有何影响？' }
    }
  },

  /* ===== 学生与教师 ===== */
  study_revision: {
    name:'复习导图', desc:'为考试梳理一个主题',
    nodes:{
      root:{ text:'主题' },
      kc:{ text:'核心概念' },
      df:{ text:'定义' },
      ex:{ text:'例子' },
      fm:{ text:'公式 / 规则' },
      mi:{ text:'常见错误' },
      eq:{ text:'考题' },
      eq1:{ text:'可能考题 1' },
      eq2:{ text:'可能考题 2' }
    }
  },
  essay_plan: {
    name:'议论文规划', desc:'中心论点、分论点、论据',
    nodes:{
      root:{ text:'文章题目' },
      th:{ text:'中心论点' },
      a1:{ text:'分论点 1' },
      a1e:{ text:'论据' },
      a2:{ text:'分论点 2' },
      a2e:{ text:'论据' },
      a3:{ text:'分论点 3' },
      a3e:{ text:'论据' },
      ca:{ text:'反方观点' },
      cr:{ text:'反驳' },
      co:{ text:'结论' }
    }
  },
  lesson_plan: {
    name:'教案', desc:'为教师和讲师准备',
    nodes:{
      root:{ text:'课题' },
      ob:{ text:'学习目标' },
      pk:{ text:'先备知识' },
      ma:{ text:'教学材料' },
      ac:{ text:'教学活动' },
      ac1:{ text:'热身' },
      ac2:{ text:'主体活动' },
      ac3:{ text:'总结收尾' },
      as:{ text:'评估' },
      hw:{ text:'课后作业' }
    }
  },
  cornell: {
    name:'康奈尔笔记', desc:'线索、笔记、总结',
    nodes:{
      root:{ text:'课程 / 章节' },
      cu:{ text:'线索 / 问题' },
      cu1:{ text:'线索 1' },
      cu2:{ text:'线索 2' },
      no:{ text:'笔记' },
      no1:{ text:'要点 1' },
      no2:{ text:'要点 2' },
      su:{ text:'总结' }
    }
  },

  /* ===== 软件与技术 ===== */
  architecture: {
    name:'系统架构', desc:'服务、数据与依赖',
    nodes:{
      root:{ text:'系统名称' },
      cl:{ text:'客户端' },
      sv:{ text:'服务' },
      sv1:{ text:'服务 A' },
      sv2:{ text:'服务 B' },
      ds:{ text:'数据存储' },
      ds1:{ text:'数据库' },
      ds2:{ text:'缓存' },
      ap:{ text:'外部 API' },
      in:{ text:'基础设施 / 部署' }
    }
  },
  sprint: {
    name:'迭代 / 功能计划', desc:'Epic → 用户故事 → 任务',
    nodes:{
      root:{ text:'Epic（史诗）' },
      s1:{ text:'用户故事 1' },
      s1t:{ text:'任务' },
      s1a:{ text:'验收标准' },
      s2:{ text:'用户故事 2' },
      s2t:{ text:'任务' },
      s2a:{ text:'验收标准' },
      de:{ text:'完成的定义（DoD）' },
      ri:{ text:'风险 / 阻碍' }
    }
  },
  postmortem: {
    name:'事故复盘', desc:'不追责的根因分析结构',
    nodes:{
      root:{ text:'事故概述' },
      tl:{ text:'时间线' },
      tl1:{ text:'发现' },
      tl2:{ text:'响应' },
      tl3:{ text:'解决' },
      im:{ text:'影响' },
      rc:{ text:'根因' },
      wt:{ text:'做得好的地方' },
      ai:{ text:'改进行动项' }
    }
  },
  rfc: {
    name:'设计文档 / RFC', desc:'技术方案大纲',
    nodes:{
      root:{ text:'RFC 标题' },
      co:{ text:'背景与问题' },
      go:{ text:'目标' },
      ng:{ text:'非目标' },
      pr:{ text:'设计方案' },
      al:{ text:'备选方案' },
      ri:{ text:'风险与权衡' },
      ro:{ text:'上线计划' }
    }
  },
  ddd: {
    name:'领域驱动设计（DDD）', desc:'限界上下文、聚合、领域事件',
    nodes:{
      root:{ text:'领域' },
      ul:{ text:'通用语言' },
      ul1:{ text:'关键术语 → 定义' },
      bc:{ text:'限界上下文' },
      bc1:{ text:'上下文 A' },
      bc2:{ text:'上下文 B' },
      cm:{ text:'上下文映射' },
      cm1:{ text:'关系（防腐层 ACL、遵奉者……）' },
      ag:{ text:'聚合' },
      ag1:{ text:'聚合根' },
      ag2:{ text:'不变量 / 一致性规则' },
      en:{ text:'实体' },
      vo:{ text:'值对象' },
      de:{ text:'领域事件' },
      de1:{ text:'事件 → 处理器' },
      re:{ text:'仓储' },
      sv:{ text:'领域服务' },
      as:{ text:'应用服务 / 用例' }
    }
  },

  /* ===== 产品与创业 ===== */
  prd: {
    name:'PRD（产品需求文档）', desc:'问题、用户、功能、指标',
    nodes:{
      root:{ text:'产品 / 功能' },
      pb:{ text:'问题' },
      us:{ text:'目标用户' },
      go:{ text:'目标' },
      ft:{ text:'功能' },
      ft1:{ text:'必须有' },
      ft2:{ text:'有更好' },
      me:{ text:'成功指标' },
      ri:{ text:'风险与待定问题' }
    }
  },
  okr: {
    name:'OKR 目标管理', desc:'目标与关键结果',
    nodes:{
      root:{ text:'季度 / 主题' },
      o1:{ text:'目标 1' },
      o1a:{ text:'关键结果 1' },
      o1b:{ text:'关键结果 2' },
      o1c:{ text:'举措' },
      o2:{ text:'目标 2' },
      o2a:{ text:'关键结果 1' },
      o2b:{ text:'关键结果 2' }
    }
  },
  persona: {
    name:'用户画像', desc:'你在为谁做产品',
    nodes:{
      root:{ text:'画像名称' },
      bg:{ text:'背景' },
      go:{ text:'目标' },
      pa:{ text:'痛点' },
      mo:{ text:'动机' },
      be:{ text:'行为习惯' },
      qu:{ text:'代表性语录' }
    }
  },
  gtm: {
    name:'市场进入（GTM）计划', desc:'发布与增长策略',
    nodes:{
      root:{ text:'产品发布' },
      ta:{ text:'目标市场' },
      po:{ text:'定位' },
      pr:{ text:'定价' },
      ch:{ text:'渠道' },
      ms:{ text:'核心信息' },
      me:{ text:'指标' }
    }
  },

  /* ===== 写作与创作 ===== */
  novel: {
    name:'小说 / 故事规划', desc:'故事前提、人物、情节、主题',
    nodes:{
      root:{ text:'故事标题' },
      pr:{ text:'故事前提' },
      ch:{ text:'人物' },
      ch1:{ text:'主角' },
      ch2:{ text:'反派' },
      pl:{ text:'情节线' },
      pl1:{ text:'开端' },
      pl2:{ text:'发展' },
      pl3:{ text:'结局' },
      se:{ text:'背景设定' },
      th:{ text:'主题' }
    }
  },
  three_act: {
    name:'三幕结构', desc:'经典剧本结构',
    nodes:{
      root:{ text:'故事' },
      a1:{ text:'第一幕：建置' },
      a1a:{ text:'激励事件' },
      a1b:{ text:'情节点 1' },
      a2:{ text:'第二幕：对抗' },
      a2a:{ text:'中点' },
      a2b:{ text:'情节点 2' },
      a3:{ text:'第三幕：结局' },
      a3a:{ text:'高潮' },
      a3b:{ text:'尾声' }
    }
  },
  article: {
    name:'文章 / 博客大纲', desc:'开头钩子、分节、要点',
    nodes:{
      root:{ text:'文章标题' },
      ho:{ text:'开头钩子 / 引言' },
      s1:{ text:'第 1 节' },
      s2:{ text:'第 2 节' },
      s3:{ text:'第 3 节' },
      ta:{ text:'核心要点' },
      cta:{ text:'行动号召' }
    }
  },
  video_script: {
    name:'视频 / 播客脚本', desc:'适用于视频频道和节目',
    nodes:{
      root:{ text:'本期标题' },
      ho:{ text:'开头钩子（前 10 秒）' },
      in:{ text:'开场介绍' },
      se:{ text:'分段' },
      se1:{ text:'分段 1' },
      se2:{ text:'分段 2' },
      cta:{ text:'行动号召' },
      ou:{ text:'结尾' }
    }
  },

  /* ===== 项目管理 ===== */
  charter: {
    name:'项目章程', desc:'范围、干系人、交付物',
    nodes:{
      root:{ text:'项目名称' },
      sc:{ text:'范围' },
      ob:{ text:'目标' },
      st:{ text:'干系人' },
      de:{ text:'交付物' },
      tl:{ text:'时间线' },
      bu:{ text:'预算' },
      ri:{ text:'风险' }
    }
  },
  wbs: {
    name:'工作分解结构（WBS）', desc:'阶段 → 任务 → 子任务',
    nodes:{
      root:{ text:'项目' },
      p1:{ text:'阶段 1' },
      p1a:{ text:'任务 1.1' },
      p1b:{ text:'任务 1.2' },
      p2:{ text:'阶段 2' },
      p2a:{ text:'任务 2.1' },
      p2b:{ text:'任务 2.2' },
      p3:{ text:'阶段 3' },
      p3a:{ text:'任务 3.1' }
    }
  },
  swot: {
    name:'SWOT 分析', desc:'优势、劣势、机会、威胁',
    nodes:{
      root:{ text:'分析对象' },
      s:{ text:'优势' },
      w:{ text:'劣势' },
      o:{ text:'机会' },
      t:{ text:'威胁' }
    }
  },
  meeting: {
    name:'会议议程', desc:'议题、决策、行动项',
    nodes:{
      root:{ text:'会议标题' },
      ag:{ text:'议程' },
      ag1:{ text:'议题 1' },
      ag2:{ text:'议题 2' },
      de:{ text:'决策' },
      ai:{ text:'行动项' },
      fu:{ text:'后续跟进' }
    }
  },

  /* ===== 职业与求职 ===== */
  interview_prep: {
    name:'面试准备', desc:'公司调研、经历故事、反问问题',
    nodes:{
      root:{ text:'公司 / 岗位' },
      re:{ text:'公司调研' },
      st:{ text:'STAR 故事' },
      st1:{ text:'领导力案例' },
      st2:{ text:'冲突处理案例' },
      st3:{ text:'失败与收获' },
      qa:{ text:'要反问面试官的问题' },
      ne:{ text:'薪资谈判' }
    }
  },
  resume: {
    name:'简历头脑风暴', desc:'把你的成绩挖出来',
    nodes:{
      root:{ text:'目标岗位' },
      ex:{ text:'工作经历' },
      ex1:{ text:'成果（带数据）' },
      sk:{ text:'技能' },
      pr:{ text:'项目' },
      ed:{ text:'教育背景' },
      ke:{ text:'职位描述中的关键词' }
    }
  },
  career_decision: {
    name:'职业抉择', desc:'权衡选项与优先级',
    nodes:{
      root:{ text:'抉择' },
      o1:{ text:'选项 A' },
      o1p:{ text:'优点' },
      o1c:{ text:'缺点' },
      o2:{ text:'选项 B' },
      o2p:{ text:'优点' },
      o2c:{ text:'缺点' },
      va:{ text:'我的优先级 / 价值观' }
    }
  },

  /* ===== 设计与 UX ===== */
  design_brief: {
    name:'设计简报', desc:'目标、受众、约束',
    nodes:{
      root:{ text:'项目' },
      go:{ text:'目标' },
      au:{ text:'受众' },
      br:{ text:'品牌 / 调性' },
      de:{ text:'交付物' },
      co:{ text:'约束' },
      in:{ text:'灵感参考' }
    }
  },
  user_journey: {
    name:'用户旅程图', desc:'阶段、行为、情绪',
    nodes:{
      root:{ text:'旅程：[用户画像 + 目标]' },
      s1:{ text:'认知' },
      s1a:{ text:'行为 / 情绪' },
      s2:{ text:'考虑' },
      s2a:{ text:'行为 / 情绪' },
      s3:{ text:'决策' },
      s3a:{ text:'行为 / 情绪' },
      s4:{ text:'留存' },
      pa:{ text:'痛点' }
    }
  },
  usability_test: {
    name:'可用性测试计划', desc:'任务、指标、参与者',
    nodes:{
      root:{ text:'测试计划' },
      go:{ text:'研究目标' },
      pa:{ text:'参与者' },
      ta:{ text:'测试任务' },
      ta1:{ text:'任务 1' },
      ta2:{ text:'任务 2' },
      me:{ text:'指标' },
      qu:{ text:'测试后问题' }
    }
  },

  /* ===== 活动与个人 ===== */
  personal_hub: {
    name:'个人仪表盘', desc:'日记、待办、习惯、目标，把生活放进一张图',
    nodes:{
      root:{ text:'我的生活' },
      jr:{ text:'日记' },
      jr1:{ text:'今天：[日期]' },
      jr2:{ text:'感恩的事……' },
      jr3:{ text:'心里在想……' },
      td:{ text:'待办' },
      td1:{ text:'今天' },
      td2:{ text:'本周' },
      td3:{ text:'将来 / 也许' },
      hb:{ text:'习惯' },
      hb1:{ text:'每天：[例如阅读 20 分钟]' },
      hb2:{ text:'每周：[例如运动 3 次]' },
      go:{ text:'目标' },
      go1:{ text:'本月' },
      go2:{ text:'今年' },
      id:{ text:'想法与笔记' },
      id1:{ text:'[随手记下任何东西]' },
      rv:{ text:'每周回顾' },
      rv1:{ text:'哪些做得好？' },
      rv2:{ text:'哪些要改进？' },
      rv3:{ text:'下周重点' }
    }
  },
  event: {
    name:'活动策划', desc:'场地、嘉宾、日程、预算',
    nodes:{
      root:{ text:'活动名称' },
      ve:{ text:'场地' },
      gu:{ text:'嘉宾' },
      ca:{ text:'餐饮' },
      sc:{ text:'日程' },
      bu:{ text:'预算' },
      su:{ text:'供应商' },
      ch:{ text:'检查清单' }
    }
  },
  trip: {
    name:'旅行计划', desc:'目的地、行程安排、预算',
    nodes:{
      root:{ text:'旅行' },
      de:{ text:'目的地' },
      da:{ text:'日期' },
      tr:{ text:'交通' },
      st:{ text:'住宿' },
      ac:{ text:'活动' },
      bu:{ text:'预算' },
      pa:{ text:'行李清单' }
    }
  },
  decision_matrix: {
    name:'决策矩阵', desc:'优点 / 缺点 / 评判标准',
    nodes:{
      root:{ text:'决策' },
      cr:{ text:'评判标准' },
      o1:{ text:'选项 A' },
      o1p:{ text:'优点' },
      o1c:{ text:'缺点' },
      o2:{ text:'选项 B' },
      o2p:{ text:'优点' },
      o2c:{ text:'缺点' }
    }
  },
  weekly_goals: {
    name:'每周目标', desc:'按领域规划你的一周',
    nodes:{
      root:{ text:'本周' },
      wo:{ text:'工作' },
      he:{ text:'健康' },
      le:{ text:'学习' },
      pe:{ text:'个人' },
      pr:{ text:'最重要的 3 件事' }
    }
  },

  /* ===== 专业领域 ===== */
  case_brief: {
    name:'法律案例摘要', desc:'事实、争点、法律规则、分析',
    nodes:{
      root:{ text:'案件名称与引证' },
      fa:{ text:'案件事实' },
      is:{ text:'争点' },
      ru:{ text:'法律规则' },
      an:{ text:'分析 / 论证' },
      ho:{ text:'判决要旨' },
      di:{ text:'反对意见 / 备注' }
    }
  },
  soap_note: {
    name:'SOAP 病历（临床）', desc:'仅提供记录框架',
    nodes:{
      root:{ text:'就诊记录' },
      s:{ text:'主观资料（S）' },
      o:{ text:'客观资料（O）' },
      a:{ text:'评估（A）' },
      p:{ text:'计划（P）' }
    }
  }
};
