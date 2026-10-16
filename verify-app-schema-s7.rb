# Limited APP schema fixture: actual migrations, minimal parent tables,
# ActiveRecord/pg and PostgreSQL WASM. Never boots Rails or accesses a real DB.
require 'open3'
require 'minitest/autorun'
require 'minitest/mock'
require 'active_record'

app = File.expand_path(ARGV.shift || raise('APP checkout required'))
fixture_in, fixture_out, fixture_error, fixture_thread = Open3.popen3(
  ENV.fetch('S5_NODE'), File.join(app, 'script/support/attendance_pglite_fixture.mjs'), ENV.fetch('S5_PGLITE_MODULE')
)
port = fixture_out.gets.to_i
raise 'disposable loopback fixture did not start' unless port.positive?
cleanup = lambda do
  ActiveRecord::Base.connection_handler.clear_all_connections!
  Process.kill('KILL', fixture_thread.pid) if fixture_thread.alive?
  [fixture_in, fixture_out, fixture_error].each(&:close)
end
at_exit { cleanup.call if $! }
Minitest.after_run { cleanup.call }
ActiveRecord::Base.establish_connection(adapter: 'postgresql', host: '127.0.0.1', port: port,
  database: 'postgres', username: 'postgres', connect_timeout: 5, checkout_timeout: 5,
  sslmode: 'disable', pool: 1, prepared_statements: false)
connection = ActiveRecord::Base.connection
# Reuse the accepted S5 fixture's minimal parents verbatim, without loading its
# tests or weakening a production migration. Fail if that fixture anchor changes.
source = File.read(File.join(app, 'script/verify_attendance_s5.rb'))
parents = source.scan(/connection\.execute\(<<~SQL\)\r?\n(.*?)\r?\nSQL/m)
raise 'S5 parent fixture anchor changed' unless parents.length == 1
connection.execute(parents.first.first)
connection.execute(<<~SQL)
  CREATE TABLE channel_whatsapp_associations(id bigint PRIMARY KEY, account_id bigint, inbox_id bigint, conversation_id bigint, contact_id bigint);
  CREATE TABLE channel_whatsapp_evidences(id bigint PRIMARY KEY, managed_channel_id bigint, session_identity text, external_message_id text, channel_whatsapp_association_id bigint);
  CREATE TABLE messages(id bigint PRIMARY KEY, account_id bigint, inbox_id bigint, conversation_id bigint, sender_type text, sender_id bigint, message_type integer, private boolean, source_id text);
SQL
%w[20261015000000_create_channel_whatsapp_ingress_admissions 20261016000000_add_attendance_durable_work 20261016000001_index_attendance_receipt_correlation].each do |migration|
  require File.join(app, 'db/migrate', migration)
end
ActiveRecord::Migration.verbose = false
CreateChannelWhatsappIngressAdmissions.new.migrate(:up)
AddAttendanceDurableWork.new.migrate(:up)
S7_INDEX_DDL = []
original_execute = connection.method(:execute)
connection.stub(:execute, lambda { |sql, *args, **options|
  S7_INDEX_DDL << sql
  # PGlite cannot run CREATE INDEX CONCURRENTLY. This verifies its generated
  # columns/uniqueness, explicitly NOT concurrent index construction.
  original_execute.call(sql.sub('INDEX CONCURRENTLY', 'INDEX'), *args, **options)
}) { IndexAttendanceReceiptCorrelation.new.migrate(:up) }

class AppIngressSchemaS7Test < Minitest::Test
  def connection = ActiveRecord::Base.connection

  def setup
    @id = connection.select_value('SELECT COALESCE(MAX(id),0)+1 FROM channel_whatsapp_evidences').to_i
    @session = 'a' * 64
    connection.execute("INSERT INTO channel_whatsapp_associations VALUES (#{@id},1,2,3,4)")
    connection.execute("INSERT INTO channel_whatsapp_evidences VALUES (#{@id},1,'#{@session}','external-#{@id}',#{@id})")
    connection.execute("INSERT INTO messages VALUES (#{@id},1,2,3,'Contact',4,0,false,'WAID:external-#{@id}')")
  end

  def admission(session: @session, journal: 'gen_random_uuid()')
    connection.select_value(<<~SQL)
      INSERT INTO channel_whatsapp_ingress_admissions
        (managed_channel_id,channel_whatsapp_evidence_id,journal_id,session_identity,external_message_id,
         proof_digest,payload_digest,accepted_at,created_at,updated_at)
      VALUES (1,#{@id},#{journal},'#{session}','external-#{@id}','#{'b' * 64}','#{'c' * 64}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
      RETURNING id
    SQL
  end

  def test_real_migration_order_tables_and_index
    %w[channel_whatsapp_ingress_admissions nexi_attendance_works].each { |table| assert connection.table_exists?(table) }
    assert S7_INDEX_DDL.any? { |sql| sql.include?('INDEX CONCURRENTLY') }
    assert connection.indexes('nexi_attendance_receipts').any? { |index| index.name == 'attendance_receipt_correlation_lookup' }
    assert_equal 'O', connection.select_value("SELECT tgenabled FROM pg_trigger WHERE tgname='channel_wa_ingress_guard'")
  end

  def test_ingress_evidence_binding_and_dedup
    assert_raises(ActiveRecord::StatementInvalid) { admission(session: 'd' * 64) }
    id = admission
    assert_raises(ActiveRecord::RecordNotUnique) { admission }
    assert_equal 1, connection.select_value("SELECT COUNT(*) FROM channel_whatsapp_ingress_admissions WHERE id=#{id}").to_i
  end

  def test_message_binding_and_immutable_confirmed_message
    id = admission
    connection.execute("UPDATE messages SET account_id=2 WHERE id=#{@id}")
    assert_raises(ActiveRecord::StatementInvalid) { connection.execute("UPDATE channel_whatsapp_ingress_admissions SET message_id=#{@id} WHERE id=#{id}") }
    connection.execute("UPDATE messages SET account_id=1 WHERE id=#{@id}")
    connection.execute("UPDATE channel_whatsapp_ingress_admissions SET message_id=#{@id} WHERE id=#{id}")
    assert_raises(ActiveRecord::StatementInvalid) { connection.execute("UPDATE channel_whatsapp_ingress_admissions SET message_id=NULL WHERE id=#{id}") }
    assert_equal @id, connection.select_value("SELECT message_id FROM channel_whatsapp_ingress_admissions WHERE id=#{id}").to_i
  end

  def test_admission_identity_and_retention_are_guarded
    id = admission
    assert_raises(ActiveRecord::StatementInvalid) { connection.execute("UPDATE channel_whatsapp_ingress_admissions SET external_message_id='changed' WHERE id=#{id}") }
    assert_raises(ActiveRecord::StatementInvalid) { connection.execute("DELETE FROM channel_whatsapp_ingress_admissions WHERE id=#{id}") }
    assert_equal "external-#{@id}", connection.select_value("SELECT external_message_id FROM channel_whatsapp_ingress_admissions WHERE id=#{id}")
  end
end
