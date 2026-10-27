# Megumin Suite: AI Slop Detector

Escopo: somente o mecanismo de repeticao/ban list da Megumin Suite. Analise estatica do repositorio; nao e uma avaliacao de resultados em RP. Nenhuma integracao foi feita no Backstage.

## O que o codigo faz

1. O operador clica em **Analyze Chat**. A extensao monta um texto do historico e faz uma geracao auxiliar pela conexao atual ou pelo preset Megumin.
2. O prompt padrao pede a LLM que encontre cinco cliches, frases de apoio ou padroes narrativos repetidos. O detalhe decisivo: ela deve converter cada achado em uma **regra geral de proibicao**, nao citar a frase observada.
3. A resposta e dividida por virgulas, asteriscos, hifens e quebras de linha. Cada parte vira um item persistente na `banList` do perfil, se ainda nao existir exatamente igual.
4. Na geracao normal, `buildBaseDict` preenche `[[banlist]]` com todos os itens. O template pede ao modelo que nunca use aqueles cliches/tropos/padroes. O interceptor substitui a tag no preset antes da chamada.

Esse "ban" e uma instrucao de prompt. Nao ha, nesse caminho, bloqueio de tokens no backend nem verificacao da resposta final contra a lista. A analise e iniciada manualmente; a lista fica ativa ate o operador remover itens. A deduplicacao compara strings exatas, nao ideias equivalentes.

## Onde pode podar o personagem

- A regra e global para o perfil, embora as mensagens analisadas possam conter varias vozes. Um gesto repetido por Mirella pode virar proibicao para Tio, GM e os demais.
- O prompt pede generalizacao. "Ela estala a lingua quando irritada" pode virar "nunca use sinais fisicos de irritacao". A segunda regra remove expressividade, nao apenas repeticao mecanica.
- Nao ha distincao entre **maneirismo identitario** (pode voltar, sobretudo sob um gatilho) e **muleta generica do modelo** (aparece em personagens diferentes sem motivo).
- Nao ha janela de validade ou intensidade. Um padrao detectado uma vez continua proibido mesmo quando o contexto muda.
- A divisao da resposta por hifen e virgula pode fragmentar uma regra mal formatada; a interface nao exige revisao antes de adicionar.
- O mecanismo nao mede se a ban list melhorou a voz nem se o modelo respeitou cada item.

## Distincao util para o nosso agente

Uma repeticao nao e automaticamente slop. Pessoas repetem palavras e gestos. O sinal de problema e a combinacao de **frequencia**, **falta de motivo na cena** e **intercambialidade entre personagens**.

| Tipo | Exemplo | Tratamento |
| --- | --- | --- |
| Traco de voz | Mirella usa uma reclamacao curta quando esta acuada | Preservar; so sinalizar excesso recente |
| Repeticao contextual | Um nome ou gesto volta porque a cena insiste nele | Preservar |
| Muleta lexical | A mesma expressao aparece em qualquer personagem | Sugerir evitar por alguns turnos |
| Muleta estrutural | Toda fala comeca com pausa, olhar e explicacao | Sugerir variar a construcao; nao proibir pausas/olhares |
| Repeticao narrativa | Toda tensao termina em uma pergunta ou provocacao | Sinalizar ao GM/diretor, nao necessariamente ao personagem |

## Prompt experimental para o agente existente

Este e um prompt **adaptado**, nao o prompt original da Megumin. Substitua os nomes das tags pelos do agente que voce ja usa.

```text
You are an RP voice-pattern analyst. Analyze only the recent dialogue and actions
of the target character. Other speakers are context, not evidence about this character.

Target character: <TARGET_CHARACTER_NAME>
Character persona: {{characterPersonality}}
Recent RP: {{recentChat}}
Previous analysis: {{previousOutput}}

Identify repeated wording, gestures, sentence shapes, and response strategies.
Distinguish stable, character-specific habits from generic model defaults.
Repetition is allowed when it is part of the character's voice or is motivated by
the current scene. Do not ban emotions, body language, silence, hesitation,
conflict, intimacy, or any broad category of expression.

Report at most three patterns that are both recurrent and currently distracting.
For each, give one brief piece of evidence, why it is a model crutch rather than
a character trait, and a narrow suggestion for the next few turns. If the
evidence is weak, report none. Preserve the persona; do not rewrite it.

Output format:
<VOICE_PATTERN_CHECK>
  <KEEP>Character-specific habits worth preserving.</KEEP>
  <SOFT_AVOID>At most three recent crutches; each with evidence and a narrow alternative.</SOFT_AVOID>
  <UNCERTAIN>Ambiguous patterns that should not become a rule.</UNCERTAIN>
</VOICE_PATTERN_CHECK>
```

Para injecao no personagem, use somente `SOFT_AVOID` com vida curta. `KEEP` serve ao analista como protecao contra falsos positivos; nao precisa virar mais uma ordem ao modelo de RP. Se o agente estiver recebendo mensagens de varios personagens sem filtrar o autor, o primeiro ajuste deve ser o recorte dos dados, nao mais regras de estilo.

## Fontes (codigo)

- Prompt padrao: https://github.com/Arif-salah/Megumin-Suite/blob/main/src/prompts/banList.js
- Botao, parse e persistencia da lista: https://github.com/Arif-salah/Megumin-Suite/blob/main/src/features/banlist/ui.js
- Chamada auxiliar: https://github.com/Arif-salah/Megumin-Suite/blob/main/src/engine/tasks.js
- Injecao da lista no preset: https://github.com/Arif-salah/Megumin-Suite/blob/main/src/engine/buildBaseDict.js
- Interceptor de prompt: https://github.com/Arif-salah/Megumin-Suite/blob/main/src/engine/injection.js
