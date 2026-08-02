# Backstage - Notas de desenvolvimento

Registro persistente de diagnosticos, decisoes e trabalho em andamento da extensao MultiCaller/Backstage.

## Estado atual

- Data da ultima atualizacao: 2026-08-01.
- O Router troca o Connection Profile conforme o personagem e depois executa `/trigger`.
- O problema intermitente de geracao sem historico ainda ocorre durante algumas trocas de profile.
- A protecao atual impede que uma requisicao sem chat seja enviada para a API.
- Existe um retry controlado para o caso confirmado de `coreChat` vazio.

## Problema: geracao sem chat apos trocar profile

### Sintoma

Depois de trocar o Connection Profile, uma geracao de personagem pode conter apenas mensagens `system`. O RP completo continua visivel no SillyTavern, mas nao aparece na requisicao enviada ao modelo.

### Fatos observados

- O problema ocorreu com mais de um personagem, incluindo Mirella Veyr e Tio Klarus.
- Ele ocorre de forma intermitente ao alternar personagens, modelos e Connection Profiles.
- Antes do `/trigger`, `SillyTavern.getContext().chat` pode estar completo.
- Em uma falha registrada, o chat externo tinha 4.675 mensagens.
- O Prompt Manager continha a entrada `chatHistory`.
- Mesmo assim, o `Generate()` interno do SillyTavern entregou `coreChat` com zero mensagens ao interceptor.
- Portanto, a perda acontece antes da montagem do prompt pelo Prompt Manager e antes da chamada da API.
- O fato de `ctx.chat` estar completo antes do trigger nao garante que o `Generate()` interno capture esse estado.
- A espera anterior baseada apenas na recuperacao do tail do chat e em uma janela silenciosa de eventos nao eliminou a falha.

### Caminho nativo relevante

1. `/trigger await=true "Personagem"` chama `Generate('normal', { force_chid })`.
2. Em chat de grupo, esse primeiro `Generate()` entra em `generateGroupWrapper()`.
3. O wrapper seleciona o membro do grupo e chama um segundo `Generate()`.
4. Esse segundo `Generate()` cria `coreChat` a partir do estado global de `chat`.
5. Nas falhas observadas, esse `coreChat` nasce vazio.

### Hipotese atual

A troca de Connection Profile inicia ou deixa pendente alguma atualizacao assincrona do estado do chat. O fluxo de geracao em grupo pode avancar durante uma janela em que o estado usado internamente pelo segundo `Generate()` esta vazio.

Isso e uma hipotese apoiada pelos logs, nao uma causa raiz comprovada. Ainda nao foi identificado qual operacao nativa limpa ou substitui o chat nesse intervalo.

## Protecoes implementadas

### Estabilizacao apos profile

- Captura as tres ultimas mensagens reais antes de `/profile`.
- Aguarda o mesmo tail reaparecer depois da troca.
- Exige uma janela estavel de 2 segundos.
- Cancela depois de 12 segundos se o chat nao estabilizar.

### Interceptor de geracao

- Registrado em `manifest.json` como `backstageGenerationInterceptor`.
- Executado pelo pipeline nativo imediatamente depois da criacao de `coreChat`.
- Registra o tamanho de `coreChat` e a presenca de `chatHistory` no Prompt Manager.
- Aborta antes da API quando `coreChat` esta vazio ou `chatHistory` esta ausente.

### Retry controlado

- Aplicado somente quando a primeira tentativa falha por `coreChat` vazio.
- Aguarda novamente o tail do chat permanecer estavel por 2 segundos.
- Repete apenas `/trigger`; nao troca o profile nem reconstrui as direcoes.
- Existe no maximo uma segunda tentativa.
- Outros erros continuam falhando imediatamente.

## Logs

A aba Logs mostra:

- Step.
- Model.
- Tokens estimados de entrada.
- Duration.
- Status.
- Request, response, reasoning e erro nos detalhes.
- Estado da troca de profile.
- Snapshot do chat antes do trigger.
- Tentativa do interceptor (`Attempt: 1/2` ou `2/2`).
- Motivo de abort e dados anteriores ao retry.

Quando a geracao e abortada antes da API, a coluna Tokens mostra `-`, pois nenhuma requisicao foi enviada.

## Resultado atual

- A causa raiz ainda nao foi removida.
- Requisicoes quebradas nao seguem mais silenciosamente para o modelo.
- O erro fica visivel e associado ao turno correto.
- O retry ainda precisa ser avaliado em uso prolongado.

## Regras para continuar o diagnostico

- Separar fatos observados de hipoteses.
- Nao considerar `ctx.chat` completo como prova de que `coreChat` estara completo.
- Nao preencher `coreChat` manualmente no interceptor: nesse ponto o ST ja processou regex, arquivos, indices e reasoning.
- Nao adicionar retries para erros genericos sem identificar que a chamada e segura para repeticao.
- Preservar os payloads e timings do log ate a causa raiz ser identificada.

