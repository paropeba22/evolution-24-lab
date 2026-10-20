# S12 — uma operação sob HOLD global

Status: **candidata de código; NO-GO para envio físico**. Nenhum deploy,
migration real, alteração de VPS/HOLD/backlog/autorização real ou envio foi
executado. A validação do destinatário e a autorização física continuam pendentes.

## 1. Baselines e causa do NO-GO

Confirmadas limpas no início e preservadas por ancestralidade:

| Componente | Baseline | Branch anterior |
|---|---|---|
| APP | `9665d1a52a76b00e9449b9d346841df324fa89e2` | `candidate/v23-prod-13-s12-authority-hold` |
| Evolution | `b206baaa0518ba881fade671942a693ca1c24188` | `candidate/v23-prod-13-s12-cutover-safety` |

Branch nova nos dois repositórios: `candidate/v23-prod-13-s12-isolated-dispatch`.
O APP foi alterado em worktree separado. Não houve substituição das candidatas
anteriores. Os SHAs finais constam da entrega e do histórico Git dessa branch.

O HOLD anterior era uma decisão global, sem autoridade para uma operação única.
`CutoverHold`, `PreparationOrchestrator` e recovery mantêm o trabalho comercial
parado. Retirar HOLD altera a elegibilidade desse trabalho. Uma autorização de
canal, mesmo atual, não escolhe mensagem, conteúdo, identidade ou execução.
Por isso uma simples exceção de telefone/texto ou um worker comum não resolveria.

## 2. Solução implementada

Uma autorização nova, durável e de uso único restringe **um texto humano novo,
uma unidade de transporte e uma execução UUID planejada**, com no máximo cinco
minutos. Não aceita mídia, reply, automação ou adoção de execução histórica.

A vinculação inclui conta, administrador autenticado, canal, inbox, conversa,
contato/ContactInbox, slot e versão/geração verificados, digest do destinatário
canônico, instância, lineages, sessão, binding generation, novo writer epoch e
digests canônicos de manifesto/payload. O token fica dentro dos envelopes HMAC
existentes; não é uma credencial bearer autônoma. Não há token baseado só em PN.

O fluxo é preview somente leitura → aprovação explícita → fencing/probe e
ativação restrita → criação e consumo transacionais. A criação reutiliza
ManagedOutboundCreation/ExecutionService, com um contexto lexical interno que
não pode ser fornecido por params. Message, execução, projeção, orquestração e
consumo ficam na mesma transação. Retry devolve a mesma Message e não enfileira
outra execução. O guard SQL também proíbe adotar IDs/request de execução antiga.

A lane reutiliza prepared proof, reserva, admission/release, consume, lease/CAS
e dispatch-start existentes. Um grant não substitui os demais requisitos. A
TTL dos grants e a autorização de preparação não ultrapassam a autorização.
A validação volta a acontecer com relógio de banco no consume e no dispatch CAS.

Uma capsule `attendance_isolated`, com um thread, usa parte do orçamento ocioso
do worker sob HOLD. Não assina filas comerciais/default/preparation/activation.
Escolhi essa opção porque não exige outro serviço nem outro sender. Usar as filas
normais reabriria a disputa com backlog; um worker separado repetiria o mesmo
contrato com infraestrutura adicional. A concorrência total configurada não sobe.

## 3. Isolamento concreto do backlog

- HOLD permanece verdadeiro em todos os caminhos normais e no limite Baileys.
- A flag `NEXI_ATTENDANCE_ISOLATED_DISPATCH_ENABLED`, ausente/falsa por padrão,
  exige HOLD literal `true` nos dois componentes. A flag não é autorização.
- Apenas o novo job com os IDs exatos da orquestração e autorização pode entrar.
  Invocar o job normal sob HOLD retorna antes de lease/decisão/alteração.
- Recovery consulta somente a tabela nova e sua execução consumida, unidade 0.
  Não varre execuções antigas, filas gerais, pending ou outcome_unknown.
- Índices únicos protegem execução planejada, request por conta e autorização
  aberta por canal. Aprovação não aumenta sua TTL por retry.
- A ativação tem modo `isolated_operation`; `dispatch_enabled?` geral continua
  falso. A autorização de canal antiga não é consultada como autoridade da lane.
- Evolution exige o mesmo token no grant, draft imutável e contexto atual do
  socket. Autorizar uma operação não habilita outro execution_id ou destinatário.
- Com a flag ativa, um antigo arquivo de boot-release não libera o HOLD global.
- Depois de dispatch-start, crash/resposta perdida é UNKNOWN e somente leitura/
  recibos; jamais uma autorização para nova escrita. Antes do CAS, o retry mantém
  a operação e precisa passar pelos mesmos guards. Não se promete entrega diante
  de crash depois do CAS: prefere-se um resultado incerto a uma duplicação.

A autorização consumida não é rearmada nem encerrada automaticamente para
permitir um segundo teste. Expiração bloqueia novas tentativas. Não existe API
de reset. Um futuro ciclo adicional exige desenho/revisão própria de encerramento;
esta candidata foi limitada a exatamente um experimento por canal.

## 4. Contratos e arquivos principais

| APP | Responsabilidade |
|---|---|
| `isolated_dispatch_contract.rb`, `nexi_isolated_dispatch_authorization.rb` | token, TTL, vínculo durável |
| `isolated_dispatch_service.rb` | autoridade/identidade, preview, aprovação, consumo, isolamento e auditoria |
| `isolated_dispatches_controller.rb` | API de administrador autenticado; confirmação explícita em cada mutação |
| `writer_barrier_service.rb`, `managed_channel_writer_barrier.rb` | fencing novo, proof real e prontidão restrita |
| `preparation_control.rb`, `admission_service.rb`, `release_contract.rb`, `transport_context.rb` | extensão simétrica do protocolo existente |
| `preparation_orchestrator.rb`, `work_queue.rb`, jobs isolados | execução por ID, mesma lease/CAS e readback |
| `attendance_sidekiq_capacity.rb`, initializer | capsule exclusiva sob HOLD, mesmo orçamento |
| migration `20261020000001`, SQL/manifest em `db/attendance/` | tabela/índices/FKs/guards e fingerprints exatos |

| Evolution | Responsabilidade |
|---|---|
| `nexi-attendance-isolated.cjs` | contrato estrito e vínculo a contexto/intent/grant |
| `nexi-attendance.cjs` | contexto/preparação e limite físico lexical sob HOLD |
| `nexi-attendance-authority.cjs` | consume, writer probe e dispatch-start existentes |
| `nexi-attendance-dispatch.cjs` | gate restrito e resultado incerto sem reenvio |
| Dockerfile e `assert-attendance-runtime.mjs` | helper presente no artefato final |

O APP necessita **uma migration nova**. Evolution não necessita migration.
Não há nova credencial, alteração Signal ou configuração da cobrança externa.
O parâmetro inteiro `isolated_dispatch` é filtrado dos logs. Auditoria real usa
canal bigint como subject, UUID da autorização em `request_uuid`, request de
criação e tipo de operação nos metadados permitidos, sem telefone ou conteúdo.

## 5. WriterBarrier e receipt_context_matches

`WriterBarrierService.receipt_context` encontra a instance lineage da instância
externa e a última sender attestation daquela sessão/canal. O manifesto precisa
conter exatamente os mesmos `instance_lineage_id`, `sender_account_lineage_id` e
`sender_attestation_id`, além dos checks de sessão, socket, epoch, binding,
versões e digest da ativação. Reconnect/rebind/nova attestation ou manifesto
antigo podem explicar o mismatch. **Não foi determinada a componente divergente
no runtime.** Não se força igualdade nem se edita o manifesto antigo.

O preview retorna presença e igualdade de cada componente, somente leitura.
O Luna deve coletar essas três igualdades, estado/epoch/generation/versões,
presença do proof e igualdade da sessão/socket/instância, sem fornecer manifesto
integral, segredo, PN ou payload. Se uma igualdade for falsa, coletar somente os
dois UUIDs daquela componente e os timestamps/proveniência das attestations.
Uma ativação nova só passa com probe autenticado do socket atual e contexto exato.

Recebimento comum não emite session.proved por mensagem. Os hooks de attestation
ficam no pairing e `CB:success` restaurado (`patchAttendanceAccountObservation`).
Um reconnect real invalida a prova e deve bloquear, sem exigir parar o ingresso.

## 6. Autorização de 11/10 e identidade

`ManagedChannelDispatchAuthorization#current_for?` não verifica idade/TTL.
Revogação, conta, vínculo inbox/instância e administrador atual determinam sua
validade. Trata-se de consentimento persistente de canal, não de grant curto;
se fosse interpretado como autorização pontual, seria insuficiente. O guard
existente permite apenas a revogação unilateral via `revoked_at`, preservando
história; mudança de papel administrativo também revoga. Não há endpoint novo
de revogação nesta entrega. Uma revisão separada pode oferecer serviço auditado
sob ChannelAuthority, pause/fencing e revogação na mesma transação. Não fazer
update direto nem revogar/criar autorização real neste procedimento.

O novo teste nunca usa essa autorização. Antes de qualquer retirada futura do
HOLD global, sua autoridade persistente exige revisão específica.

O owner precisa ser comprovado pelo Luna no runtime: incoming anchor legítimo,
associação/evidência correlacionada, slot verified sem conflito histórico, versão
atual/geração, PN/LID autenticados, conta/canal/inbox/conversa/ContactInbox e
instance/sender lineages coerentes. Comparar o número completo por evidência
privada autorizada; não deduzir de DDD/últimos dígitos ou de UI. A confirmação
fornece independentemente digest do destinatário e ID de versão do preview.
Qualquer divergência mantém NO-GO. A lane não normaliza oito/nove dígitos para
escolher outro destinatário.

## 7. Evidências de teste e limites

Tudo foi executado em laboratório local com dados sintéticos, rede bloqueada
nos testes e escrita física substituída por mock. PostgreSQL 16.15 em loopback,
Ruby 3.4.4/ActiveRecord 7.1.5.2; nenhum banco operacional foi acessado.

| Verificação | Resultado |
|---|---|
| Contrato Ruby/cápsulas/golden fixture | 4 testes / 21 assertions PASS |
| PostgreSQL, migration, guards e serviços reais | 13 testes / 75 assertions PASS, com writer/modelo reais de auditoria |
| Contratos/guards APP selecionados (inclui os quatro novos) | 34 testes / 683 assertions PASS |
| Ingresso + saída isolada | 99/99 PASS (76 ingresso + 23 isolados) |
| Concorrência na fronteira física simulada | uma escrita; retry e perda de resposta sem segunda escrita |
| 10 mil operações antigas e 10 mil jobs de filas não assinadas | nenhuma autoridade herdada/consumo físico |
| S6 | 36/36 PASS |
| Transporte/build MySQL | 142/142 PASS; build PASS |
| TypeScript PostgreSQL `--noEmit`, builds PostgreSQL/MySQL, R1/R2 | PASS; sem execução do servidor |
| Modelos/hooks/runtime PostgreSQL, MySQL e psql_bouncer | gates PASS |
| Source/modelo/selector de provider | 22/22 PASS |
| Suíte ampla Evolution | 571/573 PASS; duas falhas de fixture preexistentes |
| Suíte geral APP | 433 runs / 2405 assertions; mesmos 17 arquivos com falha da baseline (429/2384) |

As duas falhas Evolution foram reproduzidas carregando os helpers originais do
SHA b206baa: os testes esperam `unguarded`, mas o guard anterior retorna
`capture_socket_mismatch`. A suíte não foi declarada totalmente verde. As falhas
APP já existiam na baseline; não foram ocultadas ou corrigidas fora do escopo.

Comandos principais reproduzíveis (ambiente de testes isolado):

```text
APP: ruby test/attendance/isolated_dispatch_postgres.rb
     NEXI_CLAIM_TEST_DATABASE_URL deve apontar para banco descartável localhost *_test.
APP: ruby test/attendance/run_source_tests.rb
Evolution: node --test attendance-isolated.test.cjs ingress-recovery.test.cjs
           NEXI_INGRESS_SOURCE_ROOT deve apontar para o source composto/pinado.
Evolution: node --test baileys-transport-s6.test.cjs
           S6_COMPOSED_ROOT e S6_DEPENDENCIES devem apontar para a composição local.
Build: Prisma generate por provider; tsc --noEmit para PostgreSQL; tsup src/main.ts;
       patches finais e assert-runtime-model/assert-groups-runtime/assert-attendance-runtime.
```

Cobertura PostgreSQL inclui aprovação/consumo idempotentes, dois workers reais,
identidade/ator/TTL/flag inválidos, receipt incompatível mantendo fencing, guard
desabilitado, imutabilidade, proibição de histórico, recovery restrito, HOLD e
prepared proof/admission/release. O tráfego simultâneo usa fixtures isoladas de
ingresso e saída no mesmo processo; não equivale a um teste de carga na instância
real. A validade da mesma identidade/sessão no runtime continua obrigatória.

**Gates ainda necessários antes de GO:** boot/request specs e integração Rails/
Sidekiq com o bundle completo e imagem final na CI compatível. `bundle check`
local bloqueou na dependência Git azure-storage-ruby ausente. Não houve build
de imagem Docker neste host. O gate TypeScript upstream MySQL continua omitido
conforme Dockerfile existente (schema Label); seu bundle foi construído/testado.
A API Actions do repositório APP retornou `total_count: 0` para workflows; a
consulta ao workflow existente no checkout `test_docker_build.yml` retornou 404.
Não foi possível dispará-lo, nem foi alterada configuração de CI/infraestrutura.

## 8. Implantação futura e rollback (não executados)

1. Revisar código e executar os gates Rails/imagem faltantes; manter NO-GO.
2. Colocar APP compatível em TODOS os web/workers, flag isolada ausente/falsa e
   HOLD true. Commit compatível: `eec40025fa348f4c55d415188b3f724420d2180c`.
3. Após autorização operacional separada, aplicar a única migration APP,
   verificando fingerprints prévios, transação e novos guards/índices/FKs.
4. Instalar candidatas finais coordenadas, flags isoladas falsas, HOLD true.
   Validar ingresso existente sem reenviar mensagens nem reproduzir journal.
5. Somente numa etapa futura autorizada configurar a flag literal true em
   APP web/worker e Evolution, mantendo HOLD true; tabela nova deve estar vazia,
   filas assinadas restritas e grants físicos antigos vencidos.
6. Preview/leitura e revisão Luna/owner precedem aprovação. Aprovar/ativar não
   cria Message. **create_message é a ação que pode enfileirar e enviar** e fica
   proibida até autorização física separada. Não chamar como teste de conectividade.

Rollback: desabilitar a flag isolada nos dois lados e manter HOLD true; parar
novas ações de criação. Retornar a código APP com a compatibilidade acima e à
Evolution b206baa, conforme procedimento operacional aprovado. Não voltar APP
direto a 9665 após upgrade SQL: seus fingerprints rejeitam os novos guards.
Não executar down, apagar autorização/lease/ativação/grant, desfazer CAS ou
transformar UNKNOWN em negativo. Conservar recibos/reconciliação. Uma operação
já depois do CAS pode permanecer incerta; rollback não autoriza reenvio.

## 9. Validação do Luna sem envio

Com flags isoladas falsas e HOLD true: atestar SHAs/imagens, migrations/guards,
configuração efetiva de filas/capacidade, ausência de autorizações novas e
invariância dos 6 outcome_unknown/4 pending/10 created reais. Consultar somente
contagens/IDs/estados; não fazer scans de recovery ou mutações.

Usar o preview autenticado sobre um anchor já existente, ou leitura equivalente
do serviço. Ele não cria Message/execução/job/autorização e não chama Evolution.
Comparar contagens antes/depois, validar identidade privadamente e coletar
`receipt_checks`. Não invocar TransportContext.perform como preflight: ele pode
pausar/agendar ativação por mismatch de socket no contrato preexistente.
Não chamar approve/activate/create_message na validação sem envio; não alterar
grants, leases, checkpoint, contadores, backlog ou consentimento de 11/10.

## 10. GO/NO-GO físico posterior

GO exige, cumulativamente: CI Rails/imagem certificada; versões coordenadas;
HOLD true em todos; lane opt-in restrita e sem filas gerais; identidade completa
independentemente comprovada; autorização NOVA para um único manifesto/execução,
administrador correto e dentro da TTL; receipt/socket/session/epoch/binding
integralmente iguais; prepared proof/reserva/admission/release/consume/CAS reais;
nenhum grant físico antigo ativo; plano de reconciliar UNKNOWN sem reenviar; e
autorização separada do proprietário para criar a operação real.

Ausência de qualquer item = NO-GO. A publicação de código não concede GO e não
autoriza nenhuma ação operacional. Recebimento deve continuar durante o teste;
reconnect/identidade alterada bloqueia a saída em vez de pedir silêncio de tráfego.
