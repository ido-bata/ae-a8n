# Organization model

project-init は、具体的な開発手順より先にorganization semanticsを定義します。

## Constitution

`../constitution/CONSTITUTION.md` が最上位です。

tool/provider/workflowに依存しないorganizational propertyのみを置きます。

## Operating Model

Operating Modelは、Constitutionを満たすために現在採用するorganization topologyです。

例:

- role / responsibility
- planning ownership
- delivery lifecycle
- review / verification topology
- release model
- decision authority

Operating Modelは交換可能です。

## Practice

PracticeはOperating Modelを実現するtool/workflow implementationです。

例:

- GitHub Issues / Pull Requests
- Linear
- Worktrunk
- CI provider
- sandbox/runtime provider

PracticeはConstitutionそのものではありません。

## Skill

Skillは、mechanically enforceableなruleの代替ではなく、context-dependent judgmentを助けるplaybookです。

agent capability向上によりSkillなしで同等以上のoutcomeが安定して得られる場合、そのSkillは縮小・削除候補です。

## Refinement review

新しいOperating Model / Practiceを採用するときは、commandやsurfaceの一致ではなく、上位guaranteeを比較します。

最低限:

- implements
- assumptions
- guarantees
- evidence
- known limits
- deviation
- re-evaluate_when
- remove_when

を必要な粒度で確認します。
