# NEXI S12 — evolução de continuidade de sender attestation

Branch coordenada APP/Evolution: `candidate/v23-s12-attestation-renewal`.

Relatório completo no repositório APP, arquivo `S12-ATTESTATION-RENEWAL.md` nessa branch. Bases: APP `32e13d472798cf1b23f489a53c4abf68239881ef`; Evolution `8c43025211f033a2363f037cc21b68a88071f370`. SHAs publicados acompanham a entrega.

A APP prova continuidade de predecessor para latest, preservando owner/instância/sessão/linhagens/PN/LID e ordem created_at,id. A Evolution exige a prova HMAC fresca com nonce e TTL, marcada localmente no contexto efetivamente retornado, inclusive cache hit. Apenas sender_attestation_id pode renovar no mesmo epoch; guards, snapshots, CAS e autoridade física permanecem separados.

Não há migration, flag ou fila nova. APP primeiro, Evolution depois, somente sob operação autorizada pelo Luna. Não implantar automaticamente, enviar, repetir operação, alterar epoch/revision/HOLD ou apagar contexto/dados. Rollback preserva dados e restaura a recusa anterior.

Verificação: APP 25 testes/157 asserções; Evolution 39 testes; syntax e diff check PASS. Fixtures não demonstram banco/atestado/transporte reais. Revisão independente sem blocker concreto. Recuperação e envio no runtime permanecem pendentes.
