# NEXI V23-PROD-13-S12 — Legacy cutover e autoridade

**S12 CONDITIONAL — EXPLICIT RESIDUAL RISK**

17/10/2026, America/Sao_Paulo. Recomendação principal: **C, uma única janela
controlada, sem imagem intermediária**, com retenção explícita de envios nos
candidatos e aceitação documentada do risco do primeiro encerramento legacy.
Isso permite programar a atualização, mas não transforma ausência de drain em
prova de quiescência. Se o proprietário exigir perda zero e coerência Signal
comprovada antes da primeira parada, a transição continua bloqueada: essa
garantia não pode ser fornecida pelos controles instalados examinados.

Nenhuma operação OVH/EasyPanel, build, migration, restart ou mensagem foi
executada. Sem laboratório, Docker descartável ou CI. Migrations/ledgers,
Google Drive e dimensionamento da VPS não foram reinvestigados.

## 1. Fatos aceitos de S11-R1 e diagnóstico exato

Signal híbrido confirmado: `Session.creds` no PostgreSQL Evolution `nexi`;
chaves no Redis `nexi_evolution-ledger-redis`, DB0, prefixo `evolution`, módulo
instance; volume `nexi_evolution-api_instances`. Uma instância e uma Session.
Backup coordenado PG+Redis+volume é obrigatório; consistência de restauração
ainda não demonstrada. APP/Evolution têm exatamente as três migrations finais
de cada lado pendentes; dependências anteriores/67 Prisma existentes aceitas.

Estado informado: uma barreira ativa, uma autorização não revogada, dez
execuções created, seis attempts associados a seis orchestration outcome_unknown,
quatro orchestration pending, zero grants físicos não expirados no instante
observado. Esses grupos podem se sobrepor; não representam vinte envios.

Legacy: upstream `e273b904d53f5726970fd6a244ed9caa61dfeb9a`; bytes e overlays de
homolog ainda não comprovados. Conclusões do fonte não certificam o artefato.

O upstream já examinado não contém endpoint/flag de maintenance pause/drain.
`connectionState` observa conexão, não idle. Presença unavailable/paused não
contém ingresso. Restart fecha/reconecta; close pode agendar reconnect em 3 s.
Logout/delete apagam credenciais e não são mecanismos de manutenção.
endSession/isDeleting são controles internos de encerramento, não pausa segura.
Bloquear somente HTTP/Traefik não bloqueia o websocket WhatsApp já conectado.

A fila eventProcessingQueue é privada; o callback acrescenta trabalho sem
retornar/aguardar toda sua conclusão. Legacy chama saveCreds sem await.
SIGTERM/SIGINT aguardam só a desativação de licenciamento e chamam process.exit.
Não há integração desse handler com fila, sockets, key store, Redis ou Prisma
onModuleDestroy. A existência desse último método não comprova sua chamada.

Baileys tem mutexes/transações locais e hooks de close, mas não um comprovante
global de que operações criptográficas, consumers e auth writes terminaram.
Flush do event buffer emite eventos; não confirma persistência pelos consumers.
É cache write-through com espera local, não um flush global de estado de sessão.

No modo híbrido, writes de Session e hashes Signal são independentes. Helpers
podem absorver falhas de escrita; promises resolvidas não comprovam commit
bem-sucedido em ambos. Patch Groups da candidata aguarda saveCreds, porém não
torna PG/Redis uma transação distribuída nem recupera trabalhos antigos.

**Ponto de risco:** decrypt pode avançar Signal; transporte pode receber ACK;
payload/eventos/callbacks ainda podem estar em memória antes da materialização
durável APP. Uma interrupção pode perder trabalho já confirmado ao transporte.
Separadamente, chaves e creds podem refletir avanços distintos se um write
falhar ou for interrompido. Não existe promessa de redelivery ou reconstrução
do que não foi journalizado. Atividade remota de sessão pode ocorrer mesmo sem
mensagem humana ou envio comercial.

## 2. Comparação e escolha

| Caminho | Conclusão |
|---|---|
| A — recursos existentes | Não fornece quiescência demonstrável. Presence, connectionState, flush local e sleep não satisfazem o gate. Swarm controla tarefas, não transações criptográficas. |
| B — imagem intermediária | Não resolve o primeiro encerramento: instalá-la exige interromper o mesmo processo sem drain. Não recomendada. Instrumentação live/debug, SIGSTOP ou checkpoint de memória também não oferecem, pelo contrato existente, um comprovante completo das operações já abertas e da coerência PG/Redis. Não serão improvisados. |
| C — janela com risco explícito | Menor caminho executável. Uma parada legacy, depois backup do conjunto parado e retomada nos candidatos S12 em hold. Aceitação explícita do resíduo antes da operação; nunca rotular como corte lossless. |

Não criar versão intermediária para alegar que hooks futuros tornam segura a
troca anterior. Não instalar debugger, hotpatch ou uma pilha de checkpoint
nesta missão. Uma solução futura de drain precisaria cercar admissões antes
do decrypt, rastrear toda operação/send/auth write, propagar erros, impedir
reconnect e expor uma confirmação verificável. Ela não corrige retroativamente
o primeiro corte sem instrumentação já presente.

## 3. Correções necessárias nos candidatos S12

Evolution base S8 `11af89c09e1eada3055be59194415b46f817c60e`, branch
`candidate/v23-prod-13-s12-cutover-safety`:

1. **Bug comprovado de readback:** a rota authority chamava dispatch quando
   achava consumo físico persistido sem dispatchStartedAt, inclusive para
   `consumption_readback`. Assim, readback_only do APP não bastava para impedir
   início físico. Corrigido: só action consume chama dispatch. Readback retorna
   fatos existentes ou prova de expiry obtida sob lock, sem iniciar envio.
2. `NEXI_ATTENDANCE_CUTOVER_HOLD=true` recusa consume e writer_probe. Dispatch
   direto e fronteira lexical assertNode recusam mensagem física antes de
   tocar a fronteira irreversível. Readbacks autenticados permanecem disponíveis.
   O fato físico do grant histórico não é reescrito para false.
3. A verificação de artefato Attendance exige a implementação do hold no helper
   copiado à imagem final. Nenhuma migration ou wire schema alterado.
4. O entrypoint gera boot_id novo e descritor operacional em /tmp, sem segredos.
   A liberação local aprovada para esse boot não reinicia o socket; novo boot
   começa retido novamente. Isso evita um segundo corte somente para mudar ENV.

APP base S7 `05fc828d70fcbf8f8d439515cd4c11fa10a16d23`, branch
`candidate/v23-prod-13-s12-authority-hold`:

- Hold retém PreparationOrchestrator antes de claim/avanço; recovery não
  registra/backfilla/notifica orchestration, mas mantém receipts/correlation.
- Bloqueia novo consentimento/ativação, prepare, admissão positiva, grants,
  release e envelope consume/writer_probe. Erro Held é operacional, distinto
  de Denied: não grava uma negativa histórica para justificar retenção.
- Contexto atual informa physical_dispatch false; preserva manifests, provas,
  epoch, PN/LID, leases, reservations e fatos persistidos. Alterações de fencing
  por troca real de socket continuam pelo serviço existente, sem reset manual.
- Com hold, Sidekiq usa somente duas threads: attendance_receipts e
  attendance_recovery. High/preparação/filas genéricas não são consumidas;
  jobs permanecem no Redis. Pool configurado 12 permanece teto, não obrigação
  de abrir doze conexões. Sem hold, configuração normal 8/2/1/1 preservada.

Configuração **explícita** nos três serviços novos antes de qualquer partida:

```text
NEXI_ATTENDANCE_CUTOVER_HOLD=true
```

Somente valor ausente ou literal false mantém comportamento anterior; typos e
valor vazio retêm. Ausência existe por retrocompatibilidade, mas é NO-GO no
primeiro boot controlado. Verificar spec Swarm e ambiente efetivo em cada task.
Flag aplicada por processo; não se altera ENV de um processo já iniciado por
um docker exec separado. Na Evolution true, o gate aceita somente marcador com
conteúdo exato do boot_id atual; ausência/erro/marcador antigo mantém hold.
Valores de configuração inválidos não podem ser liberados por marcador.
Não é um drain, pausa de ingressos ou prova de idle.

Hold Evolution bloqueia todos os stanzas message, inclusive Groups e controles
próprios que usem esse tag. IQ/receipt/ACK não se tornam mensagens comerciais,
e continuam sujeitos aos guards existentes. Processamento de ingressos e
retomada de outboxes/efeitos podem continuar; parte dos controles/replies pode
ficar impedida. Não anunciar funcionamento irrestrito enquanto held.

## 4. Backlog: comportamento e destino

| Estado | Sem hold no S5 | Procedimento S12 |
|---|---|---|
| Barreira ativa + consentimento vigente | Novos jobs/eventos podem reutilizar autorização e reativar o writer após troca de socket. Pause isolado não impede isso. | Hold bloqueia job/serviço/probe; não revogar consentimento ou editar manifest à mão. |
| Execution created sem orchestration registrada | Recovery registra unidades/identidades estáveis e enfileira trabalho. Created não comprova ausência de tentativa física relacionada. | Reter. Inventariar IDs e relações; não tratar como novo envio autorizado pela atualização. |
| Orchestration pending | Pode preparar/readback; depois de proof, admitir/liberar/consumir em ciclos subsequentes, sem nova aprovação operacional. | Reter as quatro. Só liberar após decisão sobre continuidade de cada unidade e alcance global das filas. |
| Trabalho só de preparação | Não é send por si só; contudo pode abrir caminho para grants nos próximos ciclos. | Também retido por padrão; não confundir prepare bem-sucedido com confirmação de envio. |
| Attempt físico outcome_unknown/dispatch_marked/transport_returned em orchestration pending | Só ramo readback_only no APP, mas rota S8 tinha o bug acima. | Usar apenas S12 para readbacks por identidade original, se autorizados; nenhum novo consumption_id, grant ou tentativa. |
| Seis orchestration outcome_unknown | Não são backfill pending e não voltam a advance no S5. | Preservar terminalidade física desconhecida. Receipts autênticos podem acrescentar evidência pelo reducer, sem reenvio. |
| Receipt/application/correlação pendente | Reducer/correlação com leases e provas existentes. | Pode processar em modo held após validação de artefatos/guards; não fabrica ACK/READ nem converte UNKNOWN em not-sent. |

Remover hold false não é uma aprovação seletiva: libera os caminhos normais e
as filas restantes. Para primeiro envio de teste, é preciso aprovar também o
backlog que passaria a ser elegível, ou resolvê-lo por controles de negócio
existentes validados separadamente. Sem esse alcance, permanecer held; não
criar SQL ad hoc de cancelamento/rewind e não oferecer allowlist inexistente.

Não usar readback em runtime legacy/S8 não corrigido como se fosse observação
inofensiva. Mesmo no S12, readback autenticado é operação operacional separada:
verifica guards, pode adquirir locks e deve usar a identidade original.
Não iniciar reconciliação em massa nesta missão ou usar ausência de receipt
como prova negativa. A informação zero grants era pontual: repetir apenas esse
gate imediatamente antes do corte, pois pending ativos poderiam criar novos.

## 5. Runbook faseado para Luna e proprietário

Protocolo obrigatório: **Luna prepara um bloco Bash READ-ONLY; proprietário
executa no SSH, responde “ok”; Luna lê e analisa a saída.** Um “ok” confirma
execução daquele bloco, não aprova mutation. Mutations têm autorização separada
e blocos identificados. Luna não precisa digitar comandos no terminal.

### Fase 0 — fechar alvos e decisão, sem manutenção

Luna prepara o bloco de [ops/s12-readonly-cutover.sh](ops/s12-readonly-cutover.sh)
com os nomes completos Swarm e container de task conferidos. O script não
descobre/seleciona BIA, não lê creds e não inicia aplicação. Devolve IDs/digests,
tasks, policy, mounts, flags de hold e hashes de arquivos de código permitidos.
Em execução futura, preencher no bloco Bash:

```bash
export NEXI_WEB_SERVICE='NOME_COMPLETO_CONFIRMADO_NEXI_WEB'
export NEXI_WORKER_SERVICE='NOME_COMPLETO_CONFIRMADO_NEXI_WORKER'
export NEXI_EVO_SERVICE='NOME_COMPLETO_CONFIRMADO_NEXI_EVOLUTION'
export NEXI_EVO_CONTAINER='ID_TASK_CONFIRMADA_NEXI_EVOLUTION'
# Luna inclui aqui o conteúdo versionado de ops/s12-readonly-cutover.sh.
```

Retornar bytes/overlays do legacy até onde identificáveis e guardar image ID
imutável. Se houver overlay que mude auth, shutdown, filas ou envio, STOP e
revisão nominal desse trecho; não extrapolar o upstream. Não repetir catálogos
de migrations nem inventário amplo. Reusar apenas as conexões READ-ONLY já
validadas em S11 para contagens atuais de authority/backlog/grants/atividade,
sem claims, creds, payloads ou mensagens. Registrar UTC e escopo por canal.

Proprietário decide se aceita explicitamente: possível perda de mensagem já
ACKed mas ainda em memória; interrupção de write/estado híbrido incoerente;
continuidade da sessão/restore não comprovados e eventual necessidade de
recuperação/repareamento posterior autorizado. Manutenção não garante lossless.
Essa aceitação não autoriza reenvio financeiro incerto, cleanup de UNKNOWN,
restauração antiga de Signal ou bypass de guards. Sem aceitação, não programar
mutation; é bloqueio técnico sob requisito de risco zero.

### Fase 1 — preparar candidatos, ainda sem trocar runtime

Depois de autorização de build, gerar imagens definitivas S12 por SHA, sem
autoativação, migration hook ou atualização de serviço. Reusar gates S10 de
artefato; não refazer missão SQL. APP usa mesmo digest web/worker; Evolution
mantém comando S8 sem migrations automáticas. Registrar digests e cobertura da
flag em código. Não usar S8 pura para receber readback nesse rollout.

Gate: artefatos finais aprovados e plano de preservação PG+Redis+volume com
destino protegido/método legível prontos. Build não satisfaz prova de sessão.

### Fase 2 — contenção de produtores e única parada legacy

Após autorização específica de manutenção/stop e aceitação residual:

1. Bloquear novas solicitações mutantes/autorizações de usuários/integrações nos
   alvos NEXI pelo controle operacional existente confirmado. Não usar pause!
   isoladamente e não editar consentimento/barrier. Suspender produtores/cron
   externos NEXI que possam criar/reliberar trabalho.
2. Quiet/TSTP em TODOS os workers APP antigos, pelo PID real confirmado; medir
   busy=0 com a observação existente validada. Conferir nenhum job de envio em
   voo conhecido, nenhuma concessão física ainda válida e nenhum produtor ativo.
   Ausência de grants não comprova drain Signal; é gate de autoridade apenas.
   Manter web callback antiga disponível enquanto Evolution ainda opera, com
   mutações de usuários contidas, para não cortar callbacks deliberadamente.
3. Zerar o serviço Evolution legacy pelo controller Swarm, uma única vez;
   acompanhar todas as tasks/nós até zero running, sem recriação. É este
   encerramento que efetivamente termina o socket e contém novos ingressos.
   Não há promessa de pausa anterior mantendo o socket conectado. Não chamar
   restart/connect/logout/delete ou remover listeners como pseudo-drain.
4. Com Evolution parada, concluir callbacks já recebidos quando possível e
   parar workers/web antigos pelo controller. Confirmar três serviços com
   réplicas desejadas zero e zero tasks antigas efetivamente executando.

StopGrace atual 10 s é uma limitação da primeira parada. Alterar a spec de um
serviço ativo pode provocar a própria substituição; não fazer um update
“preparatório” para melhorar grace e alegar que evitou o primeiro corte. Não
presumir que mudança de grace na spec já tenha alcançado task antiga.
Quiet/busy=0 reduz o risco Sidekiq; não prova idle Evolution. Se existir modo
operacional comprovado de aplicar grace sem substituição, revisá-lo antes de
usar; não foi comprovado aqui. O efeito real TERM/KILL deve ser registrado.

Qualquer KILL/OOM, erro auth/storage, send em voo ou callback incerto não é PASS:
STOP, preservar o estado parado e registrar incidente antes de DDL/retomada.
A autorização residual do corte não autoriza continuar automaticamente após
falha observada. Inatividade por tempo escolhido pelo operador apenas reduz
probabilidade de resíduo; nunca será rotulada como prova de drain.

### Fase 3 — ponto de corte e preservação

O ponto **comprovável** é operacional: após zero tasks antigas em todos os nós,
nenhum outro writer NEXI/cron/administrador mutante, e encerramento das conexões
e transações de escrita conhecidas. Registrar cut_id e UTC. Isso comprova
ausência de progresso futuro pelo runtime parado; não comprova que nenhuma
operação foi interrompida nem que PG/Redis já eram semanticamente coerentes.

Com todos os escritores NEXI ausentes, capturar o conjunto corrente PG Evolution
`nexi`, Redis DB0 com dados/tipos/TTL necessários, volume
`nexi_evolution-api_instances`, APP/Redis Sidekiq e storage que participem do
corte. Copiar sequencialmente é coordenado porque esses writers não avançam
nesse intervalo. Não copiar só hashes Redis de nomes conhecidos: preservar
namespace/estado inteiro relevante. Não ler/expor valores de auth em relatório.

Luna prepara o bloco mutante de export pelos mecanismos/credenciais já
provisionados, com aprovação separada. Não usar SAVE/FLUSH/restart/restauração
global em Redis compartilhado. Se o serviço não for exclusivo NEXI, exigir
plano de export e recuperação de escopo comprovado sem tocar BIA; caso contrário
NO-GO. Não reconfigurar auth, TTL, eviction ou backend de sessão na janela.

Manifest: cut_id, UTC de cada cópia, alvos/digests, PG+Redis+volumes+storage,
hashes, tipos/formato, ferramentas, saída, destino protegido e procedimento de
recuperação. Verificar leitura/integridade dos arquivos sem carregar creds em
logs. Ausência de evidência de restauração continua uma lacuna explícita; hash
e listagem não a resolvem. Não prometer recoverability de sessão avançada.
Sem cópia corrente completa e legível, não executar migrations.

### Fase 4 — Swarm zerado e ativação em hold

Com serviços zerados, Luna prepara alterações autorizadas de spec: digests S12,
update/rollback stop-first, falha pause sem rollback automático, grace suficiente
para as tarefas novas e `NEXI_ATTENDANCE_CUTOVER_HOLD=true` nos três serviços.
Proposta para novos workers: grace 60 s para timeout 25 s; não usar 10 s.
Conferir que editar pelo EasyPanel não reativa réplicas nem restaura start-first.
Stop-first individual não substitui zero writers entre serviços.

Executar apenas migrations já aprovadas, em tarefas únicas separadas. Ordem:

1. Migrations APP; web APP S12 em hold, workers zero; guards/boot corretos.
2. Migrations Evolution; iniciar uma réplica Evolution S12 em hold, usando o
   estado CORRENTE preservado, mesmo backend híbrido e nenhum restore antigo.
3. Confirmar flag efetiva, socket/owner/session e ausência de escritores antigos.
   Boot Evolution já reconecta, recebe, avança Signal e retoma efeitos/outboxes;
   faz parte da operação autorizada, não é teste passivo. Primeiro boot inaugura
   um novo avanço; o snapshot do corte não vira rollback de sessão.
4. Iniciar worker APP S12 held: confirmar somente attendance_receipts e
   attendance_recovery, total duas threads, sem high/default genérico/preparação.
   Verificar que as quatro pending e seis UNKNOWN não foram reclassificadas
   por retenção; receipts reais podem legitimamente acrescentar evidência.

Só afirmar ausência de envio da candidata se a flag true estiver em TODOS os
processos e a fronteira de envio do artefato estiver correta. Bytes/overlays
imprevistos, qualquer frame message escapando ao hold ou nova liberação => STOP.
Endpoints chamados health/context podem persistir estado ou pausar/enfileirar
ativação. Não invocá-los como inspeção READ-ONLY. Não usar connect/retry/probe
até fase expressamente autorizada.

### Fase 5 — evidência e liberação posterior

Observar recebimento autorizado e receipts/correlação possíveis em hold, sem
forçar protocolo de controle bloqueado. Persistir ids/tempos e explicar qualquer
fluxo retido. Não fazer campanha de mensagens nem testes em clientes reais.

Antes de remover hold, decidir destino de cada pending/created e dos jobs que
as filas normais poderão consumir. Receipts e readbacks comprovados não dão
autorização comercial nova. UNKNOWN continua sem resend. Se o proprietário
autorizar somente um teste e não a retomada do restante, **manter hold**;
resolver a seleção pelo fluxo de negócio apropriado, sem SQL improvisado.

Remover hold é nova fase mutante: conter produtores, quiet/parar worker held,
configurar APP web/worker com flag false, worker ainda zero, e conferir web.
Na Evolution manter ENV true e liberar o boot atual pelo utilitário abaixo,
sem restart/socket novo; depois iniciar worker normal. Usar o fluxo existente de ativação/fencing;
novo socket não herda autoridade por ser a mesma sessão. Autorizar envio de
teste e a retomada do backlog elegível de forma explícita. Não editar epoch,
grants, leases, PN/LID, tokens ou manifests.

Luna fornece o bloco abaixo **somente após autorização física e de backlog**,
com container e boot_id provenientes da observação atual da fase0/4:

```bash
# MUTANTE: libera a fronteira de envio deste boot; não executar como healthcheck.
: "${NEXI_EVO_CONTAINER:?task atual confirmada}"
: "${NEXI_APPROVED_BOOT_ID:?UUID do boot atual aprovado}"
docker exec "$NEXI_EVO_CONTAINER" node /evolution/ops/s12-release-current-boot.cjs "$NEXI_APPROVED_BOOT_ID"
```

O utilitário valida descritor de boot, hold true e PID1 Node, grava marcador
0600 por rename atômico e não importa a aplicação nem toca credenciais/Signal.
Executar como o mesmo UID do runtime. PID1 diferente de Node é STOP: não buscar
PIDs arbitrários ou desativar a validação. A configuração da imagem S12 deve
preservar exec Node direto; confirmar eventual init/wrapper no gate de artefato.
Não copiar marker entre tasks. Se task reiniciar, novo boot fica held mesmo se
/tmp persistir. Remover marker volta a bloquear futuras fronteiras de envio,
mas não desfaz mensagem já emitida nem comprova drain de operação em voo.
Não usar a mudança como substituto de quiescência em futuras atualizações.

## 6. Gates e falhas

| Gate | GO | NO-GO/STOP |
|---|---|---|
| Decisão do primeiro corte | Proprietário aceita o resíduo definido e escopo de manutenção. | Exige prova lossless que o legacy não oferece, ou ausência de autorização. |
| Identidade | Targets/digests/overlays e ownership NEXI conferidos. | Ambiguidade, BIA compartilhada sem solução ou overlay que mude o contrato. |
| Pré-parada | Produtores contidos, workers quiet/busy0, grants atuais expirados, nenhum send em voo conhecido. | Novo grant/send em andamento; não interpretar silêncio como drain. |
| Pós-parada | Controller desejado0 e todas as tasks antigas0; incidente de shutdown avaliado. | Recriação, coexistência, KILL/OOM/write failure ou resíduo concreto não avaliado. |
| Corte | Conjunto corrente completo, protegido, legível e manifestado; lacuna de restore explícita. | Falta PG, Redis, volume ou recuperação de escopo seguro. |
| Boot | Imagens S12 corretas, holds true, guard válido, socket/session/owner atuais. | Sessão ausente/corrompida, novo QR inesperado, storage/auth error, flag ausente ou mensagem escapando. |
| Worker held | Duas threads e somente receipt/recovery; histórico preservado. | High/default/preparation consumindo ou UNKNOWN resetado. |
| Liberação | Destino do backlog e envio expressamente autorizados. | Aprovação parcial incompatível com remover hold global. |

Falha depois de reconectar: conter novas mutações/envios e preservar estado
ATUAL. Não restaurar Session/Redis/volume do corte sobre sessão que avançou.
Não usar rollback Swarm automático. Corrigir para a frente; se continuidade
Signal falhar, recuperação/repareamento é decisão operacional separada. Não
reiniciar em loop nem apagar a sessão para testar. Estados financeiros UNKNOWN
permanecem retidos, mesmo se for necessário recriar sessão posteriormente.

### Blocos mutantes de referência — separados pelos gates

Luna só fornece cada bloco após a autorização específica e a análise do bloco
anterior. Não executar todos de uma vez. Identificadores já confirmados; as
configurações devem também persistir na fonte canônica EasyPanel, para impedir
que sua reconciliação reabra réplicas/overrides antigos.

```bash
# Fase2/quiet: SOMENTE se PID1 da task foi confirmado como o Sidekiq efetivo.
: "${NEXI_WORKER_CONTAINER:?task Sidekiq antiga confirmada}"
docker kill --signal=TSTP "$NEXI_WORKER_CONTAINER"
```

Parar e medir busy=0 pelo mecanismo de observação já validado. Não prosseguir
apenas porque o sinal foi aceito. Se PID1 é wrapper, Luna prepara sinal ao PID
real comprovado em novo bloco; não envia sinal arbitrariamente.

```bash
# Fase2/parada única legacy: após gates e aceitação do risco residual.
: "${NEXI_EVO_SERVICE:?serviço antigo confirmado}"
docker service scale "${NEXI_EVO_SERVICE}=0"
```

Luna lê as tasks de todos os nós e avalia a saída/encerramento. Somente depois
de zero Evolution e avaliação dos callbacks/worker quiet:

```bash
# Fase2/parada restante, sem apagar filas/volumes.
: "${NEXI_WORKER_SERVICE:?serviço worker confirmado}"
: "${NEXI_WEB_SERVICE:?serviço web confirmado}"
docker service scale "${NEXI_WORKER_SERVICE}=0" "${NEXI_WEB_SERVICE}=0"
```

Depois do backup/corte aceito, exemplo de parâmetros da spec nova, mantendo
desired0. Repetir somente para os três alvos confirmados e seus digests corretos:

```bash
# Fase4/spec: NEXI_TARGET_SERVICE é um único alvo; não seleciona todos os serviços.
: "${NEXI_TARGET_SERVICE:?alvo NEXI confirmado e zerado}"
: "${NEXI_CANDIDATE_DIGEST:?digest aprovado para esse componente}"
test "$(docker service inspect --format '{{.Spec.Mode.Replicated.Replicas}}' "$NEXI_TARGET_SERVICE")" = 0 || exit 1
docker service update --replicas 0 --image "$NEXI_CANDIDATE_DIGEST" \
  --env-add NEXI_ATTENDANCE_CUTOVER_HOLD=true \
  --update-order stop-first --rollback-order stop-first \
  --update-failure-action pause --rollback-failure-action pause \
  --stop-grace-period 60s "$NEXI_TARGET_SERVICE"
```

Aberturas são três blocos separados, cada qual **após** seu gate e migrations
aprovadas: `docker service scale "${NEXI_WEB_SERVICE}=1"`, depois
`docker service scale "${NEXI_EVO_SERVICE}=1"`, por último
`docker service scale "${NEXI_WORKER_SERVICE}=1"`. Todos ainda held nesse estágio.
Estes comandos não substituem verificação dos comandos/entrypoints e política
canônica EasyPanel. Mudança inesperada ou recriação antiga exige STOP.

## 7. Evidência de correção e próxima ação

Regressão da rota reproduzida com fonte S8 carregado somente em memória:
readback chamou dispatch uma vez onde o teste exige zero. Mesmo teste no S12
passa. Testes focalizados Evolution authority/physical/cutover: **65/65**,
incluindo readback antes/depois de expiry, UNKNOWN preservado, hold e caminho
consume normal. Network trap proíbe acesso de rede. Dependências já disponíveis
foram reutilizadas por resolver de testes; sem build/server/DB/lab.

APP: **7 testes/53 asserções** de retenção e decisões não gravadas; **2 testes/11
asserções** na API real Sidekiq 7.3.1, sem Redis/Rails, conferindo filas e orçamento
normal/held. Sintaxe e diff verificados. Nenhum resultado prova quiescência do
runtime antigo ou restauração da sessão. Nenhuma mutation histórica/migration.

Próxima ação: Luna entrega ao proprietário o bloco READ-ONLY da fase0 e recolhe
os alvos/digests/overlays e contagens atuais necessárias, pelo protocolo SSH/ok.
Proprietário decide sobre o risco residual antes de autorizar a janela. Builds,
parada, backups/export, DDL, troca e envio exigem suas autorizações de fase.
Com essas condições satisfeitas, programar uma única atualização para S12 held;
não repetir revisão de migrations ou instalar uma imagem intermediária.
