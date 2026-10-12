# NEXI V23 — contrato de perfil autenticado

Baseline main: `90fd9eb974616531c9ceeb08911871ab9f552d6d`.
Branch: `fix/v23-attendance-contact-metadata`.

Companion APP: `paropeba22/isp-platform-lab`, baseline V20.1
`e85a50d5c93cdb47cb6fb85ded1b6ca739c99c3b`, branch
`fix/v23-attendance-identity-send-evidence`.
Relatório completo: `docs/attendance/v23-integrated-investigation.md` na APP.

O decoder fixado usa `attrs.notify` como pushName. A capacidade do decrypt agora
conserva esse nome e origem explícita, sem buscar nome cadastral ou em cache.
O contrato `identity.observed/correlated` conserva os campos de identidade V1 e
adiciona `contact_profile` opcional, filtrado pelo signer. A APP deve ser publicada
com a migration `20261011000002` antes deste adaptador: o receiver anterior rejeita
campos extras. Não mudar a ordem de rollout nem relaxar o receiver antigo.

Foto: PN exato no socket da mesma sessão, método existente profilePictureUrl.
HTTPS subdomínio whatsapp.net, sem credenciais/fragmento/porta alternativa. Cache
por serviço/instância/session/PN, seis horas para êxito e indisponibilidade,
512 entradas, uma consulta pendente e throttle de um segundo. Espera da ingestão
limitada a dois segundos; consulta ainda pendente bloqueia novas. Sem retry,
scheduler, importação, resolver de número ou dependência de foto disponível.
Reinício/expulsão pode invalidar cache. A foto é informação de apresentação,
nunca prova de destinatário. Privacidade/URL expirada resultam em fallback.

Mudanças: `nexi-identity.cjs`, `nexi-transport.cjs`,
`patch-financial-delivery-source.mjs` e este documento. O patch alterado contém
o ponto já existente de ingestão: não muda o transporte financeiro ou de saída.
WriterBarrier/grants/CAS/dedup/receipts e módulo de dispatch não foram alterados.

Inspeção estática dos bytes/anchors upstream, limites e integração com APP,
Node --check e git diff --check. Nenhum teste, build, patcher executado, container,
VPS, migration, deploy ou WhatsApp real. O “oi” anterior não foi reenviado e seu
resultado continua desconhecido sem os logs da tentativa. Candidato para revisão,
sem aceite E2E. Os SHAs finais estão nos refs da entrega.
