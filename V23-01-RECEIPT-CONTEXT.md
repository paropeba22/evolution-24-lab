# V23-01 — confirmação do contexto de captura

Branch `fix/v23-attendance-contact-metadata`, correção descendente do candidato
revisado `92cbf2a38738d44fee85cf0564628c8f5ea8cbfe`. Canônica `main` preservada em
`90fd9eb974616531c9ceeb08911871ab9f552d6d`.

Companion APP: `fix/v23-attendance-identity-send-evidence`, descendente de
`fd3955a3121822dca6d8987871e406068fc172ed`; relatório integrado do patch em
`docs/attendance/v23-01-v23-02-corrections.md` nessa branch.

A captura lê o contexto do registro compartilhado de `configure`/`inheritConfig`
do socket. Agora todos os instaladores assíncronos desse registro compartilham
uma sequência que impede respostas superadas. A instalação também impede
regressão de epoch/geração/estado, troca de escopo e substituição de atestação
não nula no mesmo epoch. Mudança de atestação requer o fencing existente.

`writer_probe` consulta contexto autenticado da APP, verifica lifecycle, owner
persistido pelo CAS e isolamento, e instala o snapshot no registro exato usado
por `capture()`. Somente então retorna `material.receipt_context` no
`writer_result` assinado, com instance_lineage_id, sender_account_lineage_id e
sender_attestation_id reais. IDs incompletos não comprovam ativação. Não há IDs
inventados, grants renovados nem preenchimento de receipts anteriores.

`dispatchStart` renova o snapshot fora dos locks e, sob os locks existentes,
exige igualdade dos IDs/escopo com a autoridade congelada da preparação.
Instala o contexto antes do CAS irreversível e confirma snapshot/owner depois
do commit. Falha após CAS continua desconhecida, sem repetição do envio.
O verificador `writerIsolation` conserva seus argumentos; sozinho não instala
contexto arbitrário. Os callers de produção usam a instalação guardada.

`sessionObserved` conserva o progresso da observação assinada mesmo quando
outro instalador vence a concorrência. Só a instalação obsoleta é descartada;
nenhuma comprovação de dispatch é derivada dessa observação.

V23-02 é implementada exclusivamente na APP, com lotes por associação pendente,
cursor finito, rechecagem de escopo/frescor, idempotência e passagem de recuperação
limitada. Evolution não precisa mudar seu contrato de ACK de identidade.

Rollout: APP corrigida antes de Evolution corrigida. A APP nova bloqueia dispatch
sem a confirmação adicional assinada, inclusive quando recebe prova do adaptador
antigo. Atualizar o adaptador e comprovar ativação posteriormente, sem relaxar
os gates. Nenhuma migration adicional. Metadados de nome/foto da V23 mantidos.

Esta correção complementa o relato histórico `V23-CONTACT-METADATA.md`: altera
o contexto e a fronteira de dispatch somente para V23-01. Inspeção estática dos
callers, patches de captura/sendNode, lifecycle/CAS, contratos e cópia dos módulos
no Dockerfile. Nenhum teste local, parser, lint, build, suíte, patcher, container,
SQL/migration, acesso a VPS, mensagem, restart ou deploy executado. O “oi” não foi
reenviado. Sem validação E2E; READY FOR INDEPENDENT REVIEW.
