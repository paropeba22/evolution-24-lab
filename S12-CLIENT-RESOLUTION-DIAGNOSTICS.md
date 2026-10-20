# S12 P0 — TypeError na resolução do cliente Chatwoot

## Veredito

A instrução que falhou no deploy **ainda não foi comprovada**. A nova evidência
operacional localiza a exceção dentro de `clientCw/getProvider/getClientCwConfig`
ou da construção do cliente, antes da preparação do POST. Não permite escolher
uma dessas operações. Esta candidata acrescenta instrumentação focalizada e
cobre o construtor completo do SDK nos testes; não contém hotfix funcional
especulativo nem promete destravar a mensagem sozinha.

Base local/remota limpa: `2198afabdae7c95e41bb152f7870d8a04047ce02`, branch
`candidate/v23-prod-13-s12-cutover-safety`; revisões anteriores preservadas.

Evidência recebida por mensagem do operador, sem leitura da VPS: tentativas
naturais 169/170, observed HTTP 200, reconcile HTTP 200/absent_retry_safe,
`client_resolution`, `TypeError/local_runtime_failure`, sem resposta HTTP,
Axios, preparação SDK, message_id ou ACK. Configuração associada presente e
habilitada foi informada pelo operador; isso não atesta os objetos injetados no
processo Evolution. Arquivo informado:
`/var/backups/nexi/s12-20261019T201102Z/eventwhatsapp-2198-target-attempts-20261020.jsonl`,
SHA-256 `c9c10fb83dfe68ab1cfa8768e999575a975e7cc8ceef41331e6751a634c3383d`.
Não se acessou esse arquivo, nem se enviou mensagem a outro thread.

## Inspeção e reproduções

`src/api/server.module.ts` inicializa `chatwootCache = null` e só instancia
`CacheService` quando `configService.get('CHATWOOT').ENABLED` é verdadeiro. Sempre
constrói `ChatwootService` com esse argumento. Em
`ChatwootService.getProvider`, o primeiro acesso ao cache é incondicional:

```ts
if (await this.cache.has(cacheKey)) {
  const provider = await this.cache.get(cacheKey);
  return provider;
}
```

Cache nulo reproduz exatamente a classe de erro anterior ao SDK, mesmo com uma
configuração da instância disponível. Mas **não se comprovou cache nulo no
deploy**. Falhas em `cache.has/get/set`, consulta da instância, provider privado,
configuração ou construtor também cabem na mesma etapa ampla. Não se removeu
cache, não se fez fallback silencioso e não se alterou configuração para assumir
essa hipótese. O `findChatwoot` real também respeita a flag global; tratar o cache
isoladamente não comprovaria o desbloqueio de uma integração globalmente desativada.

O SDK fixado 1.1.17 exporta `__esModule=true`, `default` como função construtora.
No bundle CJS examinado, a importação é o helper de interop aplicado a
`require('@figuro/chatwoot-sdk')`, seguido de `new ...default(...)`; não foi
encontrado um defeito universal de importação. O construtor real instancia seus
serviços e atribui configuração, sem iniciar POST.

O teste anterior substituía o construtor por uma classe com apenas `messages`.
Essa cobertura era insuficiente para excluir falha na construção completa.
`ingress-chatwoot-test-support.cjs` agora carrega o `dist/index.js` real e chama
seu construtor completo. Só injeta `Messages` com a fronteira Axios simulada já
existente. Os 65 testes anteriores passaram com essa construção; os testes novos
também incluem a construção bem-sucedida até a reconciliação/ACK.

## Alterações somente de diagnóstico

`patch-ingress-source.mjs` acrescenta marcos imediatamente antes das instruções
relevantes, preservando ordem, condições e retornos:

| `operation_step` | Próxima operação / local da falha capturada |
| --- | --- |
| `provider_cache_probe` | `cache.has(cacheKey)` |
| `provider_cache_read` | `cache.get(cacheKey)` |
| `provider_instance_read` | `waMonitor.waInstances[name]?.findChatwoot()` |
| `provider_cache_write` | `cache.set(cacheKey, provider)` |
| `provider_bind` | Setter privado `this.provider = provider` |
| `client_config` | `getClientCwConfig()` |
| `client_construct` | `new ChatwootClient({config})` |
| `client_ready` | Cliente construído |

Antes do probe, `nexi-ingress.cjs::creationClientState` registra somente booleanos:
presença do cache/instância, existência de métodos has/get/set/findChatwoot e
se o import do SDK é função. Não registra o objeto, configuração, valores do
provider, nome da instância, telefone ou headers. Um probe/leitura/escrita que
falha continua falhando; nenhum desses booleanos autoriza criação ou ACK.

`creationErrorSite` extrai, quando disponível, apenas artefato por allowlist e
coordenadas numéricas da exceção. Reconhece os providers Linux conhecidos,
`dist/main.js` e `@figuro/chatwoot-sdk/dist/index.js`. Emite
`error_artifact`, `error_line`, `error_column`; não emite stack, função, mensagem
da exceção, caminho arbitrário ou linha de source. Limita tamanho e quantidade
de frames examinados. Stack ausente, estranho ou getter que lança não impede a
classe segura de ser registrada. As coordenadas precisam do artefato exato da
mesma revisão para interpretação; não são prova de transporte ou autoridade.

Não houve alteração no SDK instalado, endpoint, payload, source ID, auth,
reservas, retries, cancelamento, leases ou checkpoints. O hash SDK aceito continua
`a5c0763b4217451dca743dd42948aac705b9fc48e9ad91c7c3db267033dcfa55`.
O fingerprint S6 do provider também permanece o mesmo.
O construtor `dist/index.js` agora também é atestado nos gates de patch e runtime
contra o pacote pristine: `41f18559644a5bb659d2735c44b36f6926f6bba3da7886b7a8cda9fe1c4f2057`.

## Testes e gates offline

| Verificação | Resultado |
| --- | --- |
| Ingresso com métodos TS e construtor SDK reais | 75/75 PASS, sem skips |
| S6 na composição real | 36/36 PASS |
| Verificadores finitos R1 e R2 | PASS |
| TypeScript 6.0.3 `tsc --noEmit`, PostgreSQL | PASS |
| Builds tsup PostgreSQL/MySQL | PASS |
| Gates finais models/groups/attendance/ingress/S6 e providers | PASS, incluindo psql_bouncer |
| Presença dos novos marcos nos dois bundles CJS | PASS |
| CLI de patch SDK pristine + rejeição de construtor divergente | PASS |
| Regressões amplas PostgreSQL | 548/550 PASS, duas falhas preexistentes abaixo |
| Transport/bundle MySQL | 142/142 PASS |
| Attendance source/runtime-model MySQL | 22/22 PASS, sem skips |

Os dez casos adicionais cobrem cache nulo, método ausente, exceção no probe,
rejeição na leitura, exceção na escrita, configuração versus import
não-construtor, construtor real concluindo uma única Message, coordenadas de
falha Linux e stack privado/inacessível. As tentativas sintéticas 169/170
mantêm zero POSTs, sem ACK/materialização, quando a falha ocorre na resolução.

Permanecem cobertos timeout antes/depois de commit, resposta perdida, HTTP
rejeitado, ACK não persistido, reconciliação de Message existente, retry,
concorrência, source incompatível, assinatura estrangeira e HOLD. O APP é
simulado nos testes; nenhuma certificação nova de concorrência em banco real.

As falhas amplas continuam sendo `attendance-storage-corrections.test.cjs:266`
e `:302`: esperam `/unguarded/`, mas recebem
`nexi_attendance_capture_socket_mismatch`. São as mesmas da baseline e da
candidata anterior. Nenhum guard de storage/autoridade/dispatch foi alterado;
a suíte ampla não é declarada integralmente verde.

## Operação segura e próxima evidência necessária

Sem mudança no APP, migrations ou configuração. HOLD, WriterBarrier, guard de
materialização, reserva transacional e proteção contra duplicação intactos.
Sem deploy, acesso à VPS, replay, nova mensagem WhatsApp, alteração de journal,
lease/contadores, sessão Signal, dispatch ou backlog financeiro.

Após implantação autorizada separadamente, o Luna deve aguardar somente a
recuperação natural do mesmo journal, sem forçar uma tentativa. Coletar a
sequência completa da mesma tentativa, com `client_state`, último
`operation_step`, classe/código sanitizado, `request_started`, presença/status
de resposta e resultado da reconciliação. Incluir as coordenadas e o hash
SHA-256 do provider executado, caso disponíveis; não enviar stack nem texto de
exceção. Se não houver tentativa natural, registrar isso sem replay.

Essa combinação discrimina cache ausente, objeto incompatível, dependência de
provider, getter/configuração e construtor. A classificação isolada `TypeError`
não justifica uma correção funcional em nenhuma dessas dependências.

Se houver conclusão legítima, conferir por leitura a única Message do source
exato e sua reserva APP, o mesmo ID em ACK/correlação e materialização local,
`succeeded/completed`, ausência de duplicação e de envio físico. Não converter
resultado incerto em sucesso, nem criar uma Message manualmente.
