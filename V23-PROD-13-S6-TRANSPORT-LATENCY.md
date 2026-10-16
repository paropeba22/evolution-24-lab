# NEXI V23-PROD-13-S6 — transporte Baileys

Veredito: **S6 TRANSPORT LATENCY CANDIDATE READY**, para homologação controlada.
Sem deploy, build de imagem, infraestrutura, migrations ou mensagens WhatsApp reais.

## Bases e ramo

Evolution GitHub: `17d86efeadb6de74685ac3d1490415da908d88d9`, parent
`3bfde91b644185c7d19a2a0a4dc9f76a05ffc3f9`, branch S4-R2 conferida no remoto.
Nova branch: `candidate/v23-prod-13-s6-transport-latency`, derivada diretamente
dessa revisão. SHA publicado informado na entrega após `git ls-remote`.
APP S5: `9bf54ed160f773a636d685863824c9a17f4c325b`, parent
`a1fa50de47e231453250f6b0445beda941948da4`. Head remota e grafo Git conferidos;
APP permaneceu intacta. Nenhuma branch canônica/S4/R2 foi alterada.

O Docker continua buscando Evolution upstream
`e273b904d53f5726970fd6a244ed9caa61dfeb9a`, com o lock original e
`baileys@7.0.0-rc13`. Nenhum upgrade global para rc14.

## Gargalos corrigidos

- `getHttpStream` fazia fetch sem signal/deadline. Esse GET também alimenta os
  blobs de app-state baixados dentro da transação do keystore: um corpo parado
  podia manter o mutex indefinidamente. Agora há deadline do início da admissão
  na fila até o fim da leitura, abort cooperativo e contabilização real.
- O pipe de descriptografia não propagava erro da origem ou cancelamento do
  consumidor. Agora usa `pipeline`, fecha os dois lados e entrega erro ao consumidor.
  IV parcial também falha pelo callback do Transform, sem throw fora dele.
- `encryptedStream` contava o chunk duas vezes ao verificar maxContentLength.
  O limite é conferido contra os bytes efetivamente recebidos; o valor exato
  permitido foi exercitado com a implementação rc13 real.
- A Evolution fornecia `node-cache@5.1.2`, cujo mset consome `val`, enquanto
  Baileys grava `{key,value}`. Na dependência real, a combinação armazenava null.
  O TTL Evolution era 300000 **segundos**, enquanto rc13 usa 300 segundos.
- Cache de protocolo passou a ser criado por socket. Chaves completas incluem
  o domínio real PN/LID; a mesma parte numérica em dois domínios não colide.
  Notificações invalidam esse mesmo namespace. Uma resposta USync iniciada antes
  de invalidação não volta a preencher o cache com o snapshot anterior.
- Consulta de foto existente recebe o pequeno backport upstream que aninha o
  tctoken dentro de picture. Nenhuma consulta nova foi adicionada ao ingresso.

## Semântica dos downloads

O helper faz somente GET e mantém o dispatcher/proxy e headers do chamador.
Combina signal externo, deadline e fence do socket. O timeout não é prova de
que um efeito remoto não aconteceu e não gera receipt nem autorização de envio.

`getHttpStream` continua retornando um Readable após headers, como exige Baileys.
Isso NÃO libera capacidade: o slot só termina com leitura real e cancelamento
confirmado, quando necessário. A Promise pública pode rejeitar enquanto o
transporte continua contado. Não se usa Promise.race para abandonar I/O.

São tratados Content-Length, bytes efetivos mesmo sem esse header, limite mais
restritivo do chamador, consumidor que fecha cedo, erro de descriptografia,
corpo parcial, resposta HTTP ruim e headers que chegam depois do fence.
Dados tardios de socket encerrado/substituído não chegam ao consumidor.

Se fetch, read ou cancel não concluir, o slot permanece ocupado. Se o cancel
rejeitar e não houver evidência independente de erro terminal do reader, o EOF
sintetizado pelo Web Streams não é aceito como conclusão de rede. Esse slot fica
explicitamente incerto e retido; não existe API que o libere por mero prazo.
`downloadStats()` informa active, queued e cancellationUnconfirmed. Um transporte
que nunca fornece conclusão exige tratamento operacional/processo encerrado;
não há watchdog que restaure sessão, destrave Signal ou repita envio.

A provider captura o socket original ao obter mídia, verifica-o antes/depois do
trabalho e mantém dispatcher também nesse caminho. O callback nativo de reparo
já existente fica vinculado ao mesmo socket e é conferido antes/depois. Timeout,
fence, cancelamento ou limite não entram no fallback legado de cinco segundos.
S6 não acrescenta reparo, retry de mensagem ou chamada sendMessage.

## Capacidade e configuração

Pool compartilhado entre bundle e Baileys pelo mesmo módulo CJS externo:

| Configuração opcional | Default | Faixa aceita |
| --- | ---: | --- |
| NEXI_DOWNLOAD_TIMEOUT_MS | 30000 | 100–120000 ms |
| NEXI_DOWNLOAD_MAX_BYTES | 67108864 | 1024–268435456 bytes |
| NEXI_DOWNLOAD_CONCURRENCY | 4 | 1–32 |
| NEXI_DOWNLOAD_PER_SOCKET | 2 | 1–8 |
| NEXI_DOWNLOAD_QUEUE_LIMIT | 64 | 0–1024 |

Defaults funcionam sem nova configuração; valores inválidos impedem construir o
socket. O orçamento efetivo é o menor entre política e limites positivos do
chamador. Signal existente não elimina o deadline. Cada mídia de conversa
ocupa no máximo um slot por socket/conversa. A fila alterna owners/conversas
eligíveis e recusa excesso com NEXI_DOWNLOAD_BACKPRESSURE.

Com concorrência maior que um, mídia geral usa no máximo total menos um;
app-state pode usar a capacidade reservada. Continua existindo limite global
para todas as classes, sem aumento cego de concorrência ou abertura de workers
criptográficos. Buffer de stream de 64 KiB e backpressure impedem download
antecipado ilimitado. A provider pode precisar materializar bytes; mídias acima
do limite configurado falham visivelmente e permanecem sob a recuperação durável
existente, sem truncamento/conteúdo inventado. Homologação deve validar a política
de tamanho necessária para os atendimentos reais.

## Contrato do cache

Adapter local síncrono, compatível com await do CacheStore rc13:
get/mget/set/mset/del/has/flushAll/close. mget retorna mapa de chave para valor,
miss retorna undefined. mset aceita value e o formato legado val; formatos
conflitantes são recusados antes da mutação. TTL explícito é em segundos;
TTL zero mantém sem expiração, ainda sujeito aos limites de memória/socket.

Defaults: 300 s; 4096 chaves; 32768 descritores; 1024 descritores por chave;
8 MiB de payload serializado e até 256 KiB por entrada. Há clone de leitura e
escrita, expiração preguiçosa e eviction LRU. Valores incompatíveis/superiores ao
limite deixam miss em vez de uma lista parcial. Descritores devem corresponder
exatamente a user@server da chave; nenhum telefone, LID, país ou equivalência é
inferido. O consumidor do cache não pode receber um descritor LID como PN.

Somente o agrupamento do cache usa JID completo. Os resultados nativos USync,
mapeamentos autenticados e persistência device-list continuam com as estruturas
originais do protocolo. Revision CAS é uma proteção de cache efêmero contra
sobrescrita após invalidação; não é prova de identidade nem transação Signal.
Ao substituir/encerrar socket, o cache antigo é fechado e limpo. Não se consulta
Redis para esse cache nem se compartilha entre sessões. Não é contact_cache R2.

## Locks e autoridade preservados

Não se move app-state, decode, chaves ou commit para fora da transação nativa.
Não se reduz a exclusividade do Signal. O erro real de rede retorna ao trabalho
que detém o mutex; o keystore nativo resolve o erro e libera o próximo waiter.
Não há timeout de execução da transação, liberação forçada, sessão restaurada,
novo mutex criptográfico ou worker extra alterando o mesmo estado.

Permanecem intactos WriterBarrier, grants/epochs/fencing, CAS de dispatch,
HMAC, reservas, outcome_unknown, contratos das automações e reparos existentes.
S6 não interpreta timeout como not-sent, retorno Baileys como entrega ou HTTP
como SERVER_ACK. Os corpos das funções nativas relayMessage, sendMessage,
handleMessage e handleReceipt são comparados com os snapshots pré-S6 e iguais.
Auth-utils/WAProto também são comparados com o pacote aceito. Não há atomicidade
nova entre Signal e journal PostgreSQL, que continua fora desta fase.

## Origem das correções

- Antecedente dirigido: [fazer-ai/baileys-api PR 379](https://github.com/fazer-ai/baileys-api/pull/379),
  merge `07683fcecf2fdb3a83411acd1c9910c68e3234f0`, head
  `b576950e551b10e65e6d3a7b7b11f6201c97e923`. Confirmou o caminho de download de
  app-state sob o keystore. Foi aproveitada a ideia de cancelamento HTTP; o
  controle de body, bytes, capacidade e falha de cancelamento é implementado
  aqui para rc13/Node. NÃO foram portados Promise.race de send, watchdog,
  restart, retry comercial ou heurísticas de recuperação dessa outra aplicação.
- Foto: [WhiskeySockets/Baileys 731cd6b5 (#2607)](https://github.com/WhiskeySockets/Baileys/commit/731cd6b5d1991a16d0c65072fd3107c43968e4a9).
  Portados o nó picture e a remoção de baseContent da chamada de token, usando
  o default já existente no builder rc13. Permanecem lookup/storage, destino,
  regras para self/grupo e timeout de IQ anteriores. Sem desabilitar tctoken.

## Composição e imagem futura

O patcher S6 roda por último, depois de S1–S4-R2. Fingerprints SHA256 de seis
arquivos pós-composição e âncoras únicas são validados antes de qualquer write.
Helpers obrigatórios também são lidos antes dos writes. Missing, divergência ou
reaplicação falham; os patchers aprovados anteriores não foram modificados.

O Dockerfile copia os dois helpers, aplica S6 antes de tsup e copia os helpers
junto com o Baileys alterado para o estágio final. O helper é externo ao bundle:
as WeakMaps e o pool não são duplicados pelo bundler. Um manifest registra os
hashes dos quatro arquivos Baileys e dos dois helpers. Assertions no builder e
no estágio FINAL exigem esses bytes e as referências nos três bundles
mysql/postgresql/psql_bouncer. Arquivo ausente/modificado ou bundle ausente falha.

Esses gates foram exercitados em fixture para fontes/arquivos e falhas. Não se
declara que uma imagem foi construída ou que os bundles finais foram executados:
isso será uma verificação obrigatória do build/homologação posterior.

## Verificações executadas

Ambiente local Node 24.19.0; rc13 real, @cacheable/node-cache 1.7.6,
node-cache 5.1.2, async-mutex 0.5.0 e TypeScript 6.0.3. Dependências somente em
.test-runtime ignorado, instaladas com ignore-scripts; sem instalar produção.
Fonte Evolution baixada da revisão aceita e conferida pelos hashes dos patchers.

Bateria S6: **27 testes, zero falhas, zero skips**. Transporte nativo fetch/Node
com servidores TCP somente em loopback, mais fetch/stream controlados para
transportes que ignoram ou rejeitam cancelamento. Um trap recusa fetch externo.
Foram exercitados: conclusão; headers lentos; corpo parado/parcial; bytes com/sem
Content-Length; consumidor fechado; cancel confirmado/ignorado/rejeitado;
capacidade e fila; contatos distintos; reserva app-state; fence antes dos headers
e durante corpo; troca de socket; TTL/formato/dependências reais; USync e
notificação reais com I/O injetado; não duplicação de tentativas; foto rc13 real;
keystore/mutex nativo com erro de download; preflight e artefato fail-closed.

Os testes registram duração de fixture, não latência NEXI. Exemplo da rodada
local: deadline antes de headers de 80 ms encerrou em aproximadamente 100 ms;
corpo com deadline 120 ms falhou em aproximadamente 140 ms. Não é uma meta de
produção nem comprovação de 2–3 segundos.

Replay completo dos patchers anteriores e S6 passou. verify-ingress-r1 é
executado antes de S6 (sua âncora antiga de mídia passa a ser encapsulada pelo
wrapper S6), com testes pós-S6 específicos para o novo vínculo de socket.
verify-ingress-r2 é executado após S6: os dez grupos de verificações passaram,
incluindo seis famílias, HMAC/dedup, limites e resultados incertos. A remoção de
foto S3, buffer S2, capture pós-decrypt, protobuf e receipts foram preservados.

**Ressalva explícita de regressão legada:** a execução adicional de
attendance-authority.test.cjs e attendance-physical-dispatch.test.cjs resultou em
49/56 PASS e sete falhas. A MESMA execução na baseline R2, sem qualquer alteração,
produziu os mesmos 49/56 e os mesmos sete nomes. Os fixtures não instalam o
registro/contexto de socket que captureContextSnapshot passou a exigir na S4;
seis falham em nexi_attendance_capture_socket_mismatch e o teste concorrente
observa zero writes. Nenhuma proteção foi desativada para fazê-los passar.
Esses sete testes NÃO recebem PASS e a suite completa de autoridade não está
certificada. Corrigir seus fixtures é pré-requisito para essa certificação,
separadamente da candidata S6, cujas funções de envio ficaram intactas.

Para reproduzir o replay finito, fornecer fonte pristine e dependências locais:

```text
node verify-transport-s6.mjs <Evolution e273b904...> <node_modules local> <SDK pristine 1.1.17> <SDK instalado com Axios 0.27.2>
S6_COMPOSED_ROOT=<S6_COMPOSITION impresso> node --test --test-timeout=15000 baileys-transport-s6.test.cjs
```

O SDK instalado deve ter o adapter-mariadb 7.8.0 no mesmo node_modules, exigido
pelo guard anterior da composição. O replay não faz npm install, build, migração
ou envio. Sintaxe Node dos arquivos novos e dos quatro JS modificados também
foi conferida, além de git diff --check.

## Arquivos, dependências e próximos gates

- nexi-baileys-transport.cjs: download, capacidade, fencing, pipe e backport picture.
- nexi-baileys-device-cache.cjs: cache efêmero de protocolo.
- patch-baileys-transport.mjs: transformações atômicas por preflight, hashes e manifest.
- assert-baileys-transport-runtime.mjs: gate builder/final.
- verify-transport-s6.mjs e baileys-transport-s6.test.cjs: replay/testes finitos.
- Dockerfile e este relatório.

Sem migration ou alteração APP. Configuração opcional descrita acima.
Não se exige outro endpoint; ingress.observed/reconcile/correlated/profile e APP
S5 continuam iguais. Rotas de upload/POST que não usam o GET getHttpStream mantêm
seus contratos anteriores; S6 não declara um timeout universal de toda a rede.

Sem bloqueio arquitetural para as correções S6 implementadas. Limites concretos:
transporte sem prova de cancelamento mantém capacidade incerta; política de
mídias grandes precisa homologação; imagem final ainda não construída; fixtures
legados de autoridade precisam atualização para certificação integral; sem
runtime real WhatsApp ou medição de p50/p95/p99. O próximo gate é corrigir esses
fixtures e homologar S3–S6 integrado em ambiente controlado, incluindo build dos
três providers, múltiplos contatos, reconexão/fencing, recibos e orçamento real
de memória. Nenhuma promoção pode se apoiar somente no tempo dos fixtures.
