# NEXI V23-PROD-13-S2 — recebimento Evolution 2.3.7 × 2.4

**Resultado: regressão determinística de custo no buffer identificada; causa dos
2–3 minutos ainda exige evidência runtime. Candidata preparada, sem promoção/deploy.**

## Referências reais e alcance

- Evolution 2.3.7: tag resolvida para `cd800f2976e1e5b682fbf86a01ee4d85ae61f370`.
- Evolution 2.4: fonte fixada no Dockerfile canônico,
  `e273b904d53f5726970fd6a244ed9caa61dfeb9a`, package version `2.4.0`.
- NEXI canônica/remoto `main`: `09cefdfac9e9bd6af1fd25eef0f84fdee11ca55c`.
- S1 publicada e confirmada via `git ls-remote`:
  `candidate/v23-prod-13-s1-ingress-measurement`,
  `9b884740a2f2293b404c3ea096a4438e3bf6bb96`.
- S2: `candidate/v23-prod-13-s2-ingress-buffer`, filha direta da S1, portanto
  descendente da canônica com toda a S1 preservada.

A comparação usa fontes e dependências fixadas, não o branch latest:
[fonte 2.3.7](https://github.com/evolution-foundation/evolution-api/blob/cd800f2976e1e5b682fbf86a01ee4d85ae61f370/src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts),
[fonte 2.4](https://github.com/evolution-foundation/evolution-api/blob/e273b904d53f5726970fd6a244ed9caa61dfeb9a/src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts).
Sem inspeção de container: a identidade binária/configuração efetivamente em
produção não foi confirmada nesta etapa. Não se afirma equivalência com qualquer
imagem antiga modificada fora dessas referências.

| Dependência | Lock 2.3.7 | Lock 2.4 |
| --- | --- | --- |
| Baileys | `7.0.0-rc.9` | `7.0.0-rc13` |
| libsignal | Git `1c30d7d7e76a3b0aa120b04dc6a26f5a12dccf67`, package 2.0.1 | npm `6.0.0` |

Os tarballs Baileys rc.9/rc13 e libsignal 6 conferem com os SHA512 dos respectivos
locks. A rc13 local também confere com os SHA256 exigidos pelo patcher NEXI:
messages-recv `850445e6f9e076b1beb98034cbc5cf79562dfda26a44f5a874a84e3609bfd710`;
event-buffer `09da9a892668084c3016108a85517d627022afd2ff57ab9cf97f6051b4dbd509`.
Somente download/extração/leitura e hashes; sem instalar/executar pacotes.

## Diferenças no recebimento

| Trecho | Comparação e implicação |
| --- | --- |
| Baileys: `CB:message` → processamento | Ambas distinguem `offline` por truthiness do atributo. Na rc13, `shouldIgnoreJid` passa antes da fila/buffer, com ACK do descarte; DM PN/LID ordinária não é filtrada pela configuração fixada. Não introduziu uma espera de minutos. |
| Baileys: mutexes | rc.9 usa `processingMutex` compartilhado por mensagens, receipts, notificações e app patches. rc13 separa `messageMutex`, `receiptMutex`, `notificationMutex` e `appStatePatchMutex`. Mensagens continuam seriais por socket; não confundir com a fila Evolution. |
| Baileys: offline | Serial nas duas. rc13 extrai o processor, captura erro por item e faz `setImmediate` a cada dez nós. Um handler lento ainda retém os seguintes; o yield não interrompe um decrypt individual. |
| Baileys: decrypt/ACK | Mapeamento PN/LID, migração de sessão, decrypt e emissão aguardada de receipt continuam antes de `observeInbound`. rc13 remove upload de prekeys + espera fixa de 1 s do ramo de falha de decrypt; mantém `retryMutex`/retry delay. Não é correto transportar literalmente o caminho rc.9 do issue #2491 para rc13. |
| Baileys: identidade/storage | rc13 acrescenta observação de identity key em `pkmsg` e altera migrações; lid-mapping passa a agrupar leituras/escritas e coalescer consultas em andamento. Há I/O antes do upsert, mas não um atraso obrigatório demonstrado. |
| Baileys: cache/transactions | `makeCacheableSignalKeyStore` mantém um mutex abrangendo I/O do store nas duas versões. É por wrapper criado, não um mutex único de todas as instâncias. Transações já usam ALS e locks por chave; rc13 acrescenta limpeza por referências. Nenhum timeout do mutex foi encontrado. |
| Baileys: buffer/histórico | `upsertMessage` emite antes de aguardar processamento do histórico/app-state, mas o evento pode ficar retido no buffer. Existem timeout de buffer de 30 s e debounce de 100 ms nas duas; nenhum é teto sob bloqueio do event loop. rc13 evita a espera inicial de 20 s em reconexão com sync anterior e acrescenta status de histórico. O timer de 120 s emite status `paused`; não é sleep que retém todas as mensagens. |
| Baileys: tipo de upsert | rc13 libera pendências quando alterna `append`/`notify`, evitando sobrescrever seu tipo, mas introduz uma varredura integral em cada emit. Regressão de custo detalhada abaixo. |
| Evolution: `eventProcessingQueue` | A cadeia `.then`, `findSettings()` aguardado por lote, histórico antes de upsert e loop serial de mensagens já estão na 2.3.7. Não há concorrência por contato nem deadline global da fila nas referências. Um item lento pode atrasar todos os seguintes da instância. |
| Evolution: histórico | Consultas amplas de chats/messages, createMany e contacts.upsert aguardado já existiam. 2.4 adiciona mapas PN/LID, cópia JSON de chats quando salva histórico, contadores e evento de conclusão; move CHATS_SET/MESSAGES_SET para depois da persistência. Aumenta trabalho condicional; duração/backlog não conhecidos. |
| Evolution: perfil/storage por item | Chat lookup, escrita da mensagem, integração Chatwoot, mídia quando aplicável, chatbot aguardado, contact lookup e `profilePicture` aguardado já existem na 2.3.7. Foto é posterior ao webhook da própria mensagem, mas ainda retém a próxima mensagem. rc13 adiciona resolução de tctoken/storage na consulta de foto. |

Configuração Evolution relevante é essencialmente a mesma: `fireInitQueries=true`,
connect/keepalive 30 s, retryRequestDelayMs 350 ms, maxMsgRetryCount 4 e transações
com 10 tentativas/3 s entre falhas. Não há override de `defaultQueryTimeoutMs`;
o default Baileys é 60 s nas duas versões. As nove esperas possíveis de commit
somam 27 s, além das operações de I/O: não constituem limite global do fluxo.
Os adaptadores de auth Redis/Prisma lidos não mudaram nesse diff; o Redis já
aguarda as escritas dentro do loop antes do Promise.all.

## Personalizações NEXI, separadas do upstream

- `patch-trusted-baileys.mjs`/`nexi-identity.cjs`: observação confiável síncrona
  depois de decrypt, com PN/LID/autenticidade por identidade de objeto.
- `patch-financial-delivery-source.mjs`: no item DM confiável, aguarda
  `contactProfile` e `managedObservation` antes do caminho Chatwoot. Perfil tem
  cache de 6 h/512 entradas, throttle de 1 s e espera local de 2 s por consulta;
  a corrida não cancela a consulta subjacente.
- `managedObservation` faz lookup do webhook e até três HTTPs de metadados com
  timeout de 10 s cada, mais backoffs de 1–1,5 s e 2–2,5 s. Correlação após ACK
  pode repetir esse ciclo. SQL e processamento da resposta não têm um teto
  global demonstrado. Estes valores são política, não tempos observados.
- `patch-groups-source.mjs`: aguarda interceptação de grupos antes do handler DM;
  um lote misto pode esperar admissão/storage de grupo. Também passa a aguardar
  `connectionUpdate` no lote; eventos de abertura podem incluir perfil e banco.
  Lifecycle checks/CAS são fronteiras de integridade, não removidos nesta etapa.
- `patch-attendance-source.mjs`: captura receipts antes do buffer e adiciona
  spans da fila/itens; falha isolada por item gerenciado evita consumir o restante
  do lote. A S1 só acrescenta o marcador síncrono `receiveInbound` no CB:message,
  sem novo await, SQL, HTTP, fila ou timer. Budgets/amostragem continuam limitados.

Não se implementou cache novo de identidade, paralelismo, bypass de WriterBarrier,
ACK antecipado, watchdog, reconexão automática por silêncio ou redução de retries.

## Regressão determinística e correção mínima candidata

Em `baileys/lib/Utils/event-buffer.js:112–116` rc13, a checagem de tipo executa
`Object.values(data.messageUpserts)` em cada emissão. Para N upserts distintos,
do mesmo tipo, acumulados sem flush/delete/absorção em histórico, materializa
0 + 1 + ... + (N−1) referências: trabalho/alocação Θ(N²). A rc.9 não tem essa
checagem por emissão. Isso é uma regressão demonstrável por leitura do código;
não prova que esse acúmulo ocorreu no incidente nem mede seu custo em ms.

A candidata altera somente `patch-trusted-baileys.mjs` e este relatório em relação
à S1. O patcher continua exigindo o hash integral rc13 original e uma âncora única.
O snapshot `.identity-upstream/event-buffer.js` permanece pristine. A ordem do
Dockerfile já aplica este patcher antes dos demais; não se alterou o Dockerfile.

A transformação guarda apenas a primeira chave no objeto interno do buffer,
reconsulta-a se foi removida e lê o tipo da entrada viva. Chaves produzidas por
`stringifyMessageKey` contêm vírgulas e não são índices inteiros: inserções novas
preservam a primeira. Sobrescrever a mesma chave conserva posição; excluir a
primeira invalida o cache; flush/destroy criam outro objeto de buffer. A lista
integral só é materializada na troca de tipo, imediatamente antes da emissão
original. Lista, ordem, tipo, referências das mensagens, consolidação/dedup,
absorção em histórico, deletes, timers e callbacks permanecem no mesmo caminho.

Para o burst homogêneo descrito, a checagem passa a Θ(N) agregada, com cache de uma
chave. Exclusões sucessivas da primeira entrada ainda podem exigir varreduras;
não se promete eliminar todo comportamento quadrático do módulo. Não se adiciona
await, timer, worker, paralelismo ou qualquer alteração de ACK/decrypt.

**Limite de validação:** apenas revisão textual do diff e dos pontos de mutação
do buffer. Patcher não executado; sintaxe, composição final e comportamento não
validados executavelmente. Não há benchmark nem prova de melhora do incidente.
WriterBarrier, CAS, HMAC, PN/LID, ordenação, idempotência e outcome_unknown não
recebem alterações no delta. A S1 original permanece intacta e publicada.

## Issues consultados como pistas

- [Baileys #2165](https://github.com/WhiskeySockets/Baileys/issues/2165): atraso
  antes de messages.upsert em rc.9; relato de sintoma, sem causa da nossa sessão.
- [Baileys #2491](https://github.com/WhiskeySockets/Baileys/issues/2491): rc.9,
  sessão conectada sem upserts; hipótese de mutex/store/ACK. Parte do ramo de
  retry descrito mudou na rc13. Não se adotou ACK antecipado nem timeout via race.
- [Baileys #2520](https://github.com/WhiskeySockets/Baileys/issues/2520): relato
  de starvation por sessões antigas em decryptWithSessions. O session_cipher.js
  do libsignal Git fixado na 2.3.7 e do npm 6.0.0 têm o mesmo SHA256
  `031b3282489ffec6a0cab23520bdf956a5bf4d15c57cb868e89fa6643255cd2b` e o mesmo
  loop sem yield de macrotarefa. É risco compartilhado, não regressão dessa função
  introduzida pela 2.4. O patch NEXI de libsignal muda diagnóstico/escopo do job,
  não acrescenta yield a esse loop. Quantidade/estado das sessões não conhecidos.
- [Evolution #2647](https://github.com/evolution-foundation/evolution-api/issues/2647):
  relato em 2.3.7 de pacote recebido sem webhook, com caminhos diversos. Reforça a
  necessidade de localizar a primeira divergência; não comprova a causa NEXI.

## Evidência runtime que ainda falta e recomendação

Sem reenvio, para mensagens naturais afetadas e controles da mesma janela,
correlacionar ref HMAC opaca, instância/sessão e relógios compatíveis:

| Evidência | O que decide |
| --- | --- |
| `baileys_received`, `receive_to_observe_ms`, `stanza_clock_delta_ms` S1 | Antes do callback versus processamento local pré-observe. Callback é posterior ao decode; atraso remoto e event-loop bloqueado antes dele continuam indistintos. |
| `buffer_age_ms` + mesmo ref até enqueue | Tempo após pré-emit Baileys antes da fila Evolution. Para imputar a varredura rc13, ainda faltam tamanho do buffer, duração/amostras de CPU em Object.values/emit, taxa, tipos e flushes na janela. A S1 não mede esses detalhes. |
| `queue_age_ms`, `pre_item_ms`, duração do lote anterior e waits | Fila/itens anteriores versus o próprio item. Correlacionar `history_handler`, `groups_intercept`, `settings_lookup`, `identity_profile`, `identity_observation`, `chatwoot_http`, `identity_correlation`, `message_persist`, `profile_picture`, `chatbot_emit`. |
| Se pré-observe alto | Ainda faltam decomposição offline/mapping/mutex/decrypt/receipt, latência do auth store e CPU/event-loop delay na mesma janela; a S1 mede somente a soma. |
| Identidade do artefato/configuração | SHA/digest carregados, versões reais dos pacotes, auth backend e flags de histórico/store, sem credenciais; separa drift do código analisado e mudança de carga. |

Ausência de linha amostrada não comprova ausência de evento/fase. Não coletar
conteúdo, chaves de sessão, JID/telefone, token, ID externo cru ou stanza bruto.

**Recomendação: manter RUNTIME EVIDENCE REQUIRED para a causa do atraso.** Revisar
a candidata de custo separadamente da hipótese causal. Não promover/deployar
nesta etapa, não voltar à 2.3.7 e não alterar filas/identidade/mutexes por suspeita.
S1 oferece localização inicial; a atribuição específica ao scan ou a decrypt/store
exige os dados adicionais acima e não é garantida por ela.

Sem testes locais, parser, lint, build, execução de patcher, instalação de pacotes,
EasyPanel, SSH, deploy, promoção, reenvio ou alteração da Evolution antiga/BIA/n8n.
Os únicos pushes desta etapa são de branches candidatas; main permanece canônica.
