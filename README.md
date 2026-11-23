# ecology9-oa

操作泛微 E-cology 9 OA 的 Agent Skill：网页登录、查询可发起流程、查看表单字段、读取流程详情、待办/已办列表、发起流程、任意 REST 接口调用。

仓库根目录本身就是一个符合 [Agent Skills 规范](https://agentskills.io/specification) 的 skill（`SKILL.md` 在根目录），同时带 `package.json` 使其可作为 pi 包安装。

## 安装

### pi

```bash
# 本地路径
pi install /home/houjun/project/ecology9-oa

# 或 git 仓库
pi install git:github.com/r1cardohj/ecology9-oa
```

### 其他 agent（Claude Code、Cursor 等支持 Agent Skills 的工具）

把本目录放入任意标准 skills 位置即可被自动发现：

```bash
git clone https://github.com/r1cardohj/ecology9-oa ~/.agents/skills/ecology9-oa   # 用户级
# 或
git clone <repo> .agents/skills/ecology9-oa     # 项目级
```

## 配置

复制 `config.example.json` 为 `config.json` 并填写，或用环境变量 `OA_BASE` / `OA_USER` / `OA_PASS`。详见 [SKILL.md](SKILL.md)。
