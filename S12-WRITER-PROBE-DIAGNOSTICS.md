# NEXI S12 — diagnóstico de escopo do writer probe

2026-10-21. Branch `candidate/v23-s12-writer-probe-diagnostics`, base `1fcd1194305e57f552c19eb9b34ba3031befd56b`.

Mudança exclusivamente diagnóstica: fase `scoped_operation_validation` antes da validação existente, classificação permitida de `nexi_attendance_isolated_authority_invalid` e booleans das flags/protocolo. Não modifica tokens, envelope, contexto, guards, HOLD, storage/CAS, filas ou dispatch. Não há migration ou dependência nova.

O contrato V2 exige COMPOSER=true também na Evolution. COMPOSER=false bloqueia V2; não é modo APP-only suportado. O guard foi preservado. Isso não demonstra que o primeiro probe da OVH tenha alcançado essa etapa; sua resposta original continua desconhecida. Nenhuma configuração operacional foi alterada por Sol.

Testes novos da rota real com storage/contexto em memória, transporte simulado e network trap: 3/3 PASS. Flags false retornam 422 com etapa/código exatos; flags true produzem prova assinada sem consumo ou dispatch-start. Dados privados não entram nos logs. Gate existente `attendance-isolated.test.cjs attendance-isolated-configuration.test.cjs`: 48/48 PASS, Node v24.16.0 com dependências já existentes. Sintaxe e `git diff --check`: PASS. Não houve DB, build pesado, laboratório, instalação, deploy ou envio físico.

Revisão independente focada: nenhum blocker identificado, guards e ordem de validação preservados. A validação de runtime/probe/recebimento físico permanece PENDENTE.

O [relatório APP](https://github.com/paropeba22/isp-platform-lab/blob/candidate/v23-s12-writer-probe-diagnostics/S12-WRITER-PROBE-DIAGNOSTICS.md) contém rastreio completo do 422, correção da correlação diagnóstica, limites da evidência e procedimento de retomada/rollback. Implantar somente após revisão, sem perder correções posteriores às bases. HOLD deve permanecer ativo; um novo envio físico deve ser realizado pelo proprietário na interface, coordenado pelo Luna. Não reutilizar autorização expirada nem editar fencing/epoch/revisão/grants por SQL.
