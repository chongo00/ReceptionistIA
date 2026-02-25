/** comando node scripts/check-appointments.cjs --last 5
 * check-appointments.cjs
 * ──────────────────────
 * Consulta las últimas citas creadas en BlindsBook Azure SQL.
 *
 * Esquema real:
 *   Schedule.Events       → Id, Start, Duration, Remarks, Creation, CreationBy, UserId
 *   Schedule.Appointments → Id, Type, CustomerId, Status, SaleOrderId, InstallationContactId
 *   Customer.Customers    → Id, CompanyId, FirstName, LastName, Email, ...
 *
 * Uso:
 *   node scripts/check-appointments.cjs                  → últimas 10 citas (24h)
 *   node scripts/check-appointments.cjs --customer 123   → citas del cliente 123
 *   node scripts/check-appointments.cjs --hours 48       → últimas 48 horas
 *   node scripts/check-appointments.cjs --last 5         → últimas 5 citas (sin filtro de tiempo)
 */

const sql = require('mssql');

const config = {
  server: 'blindsbook-test.database.windows.net',
  port: 1433,
  database: 'db_blindsbook-uat',
  user: 'testmaster',
  password: 'T530d5e5c5ee2c5d98b790e8e8989d22a',
  options: {
    encrypt: true,
    trustServerCertificate: true,
  },
  connectionTimeout: 15000,
  requestTimeout: 15000,
};

const TYPES = { 0: 'Quote/Cotización', 1: 'Installation/Instalación', 2: 'Repair/Reparación' };
const STATUS = { 0: 'Pendiente', 1: 'Confirmada', 2: 'Completada', 3: 'Cancelada' };

async function main() {
  var args = process.argv.slice(2);
  var customerId = null;
  var hours = 24;
  var lastN = null;

  for (var i = 0; i < args.length; i++) {
    if (args[i] === '--customer' && args[i + 1]) { customerId = parseInt(args[i + 1], 10); i++; }
    else if (args[i] === '--hours' && args[i + 1]) { hours = parseInt(args[i + 1], 10); i++; }
    else if (args[i] === '--last' && args[i + 1]) { lastN = parseInt(args[i + 1], 10); i++; }
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════');
  console.log('  📋 BlindsBook — Verificar Citas Agendadas');
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Servidor:  ' + config.server);
  console.log('  BD:        ' + config.database);
  if (customerId) {
    console.log('  Filtro:    CustomerId = ' + customerId);
  } else if (lastN) {
    console.log('  Filtro:    Últimas ' + lastN + ' citas (sin filtro de tiempo)');
  } else {
    console.log('  Filtro:    Últimas ' + hours + ' horas');
  }
  console.log('───────────────────────────────────────────────────────');

  var pool;
  try {
    console.log('⏳ Conectando a Azure SQL...');
    pool = await sql.connect(config);
    console.log('✅ Conectado\n');

    var request = pool.request();
    var whereClause = '';

    if (customerId) {
      whereClause = 'WHERE a.CustomerId = @customerId';
      request.input('customerId', sql.Int, customerId);
    } else if (lastN) {
      whereClause = '';
    } else {
      whereClause = 'WHERE e.Creation >= DATEADD(HOUR, -@hours, GETUTCDATE())';
      request.input('hours', sql.Int, hours);
    }

    var topN = lastN || 20;

    var query = `
      SELECT TOP ${topN}
        a.Id             AS AppointmentId,
        a.Type,
        a.CustomerId,
        a.Status,
        a.SaleOrderId,
        c.FirstName,
        c.LastName,
        c.CompanyId,
        c.Email,
        e.Start          AS StartDate,
        e.Duration,
        e.Remarks,
        e.UserId,
        e.Creation       AS CreatedDate,
        e.CreationBy,
        e.LastModification
      FROM Schedule.Appointments a
      JOIN Schedule.Events e ON e.Id = a.Id
      JOIN Customer.Customers c ON c.Id = a.CustomerId
      ${whereClause}
      ORDER BY e.Creation DESC
    `;

    var result = await request.query(query);

    if (result.recordset.length === 0) {
      console.log('📭 No se encontraron citas.\n');
      console.log('   Sugerencia: Prueba con --last 5 para ver las últimas 5 citas sin filtro de tiempo.');
    } else {
      console.log('📋 ' + result.recordset.length + ' cita(s) encontrada(s):\n');

      for (var j = 0; j < result.recordset.length; j++) {
        var row = result.recordset[j];
        var typeName = TYPES[row.Type] || ('Tipo ' + row.Type);
        var statusName = STATUS[row.Status] || ('Status ' + row.Status);
        var startStr = row.StartDate ? new Date(row.StartDate).toLocaleString('es-US', { timeZone: 'America/New_York' }) : 'N/A';
        var createdStr = row.CreatedDate ? new Date(row.CreatedDate).toLocaleString('es-US', { timeZone: 'America/New_York' }) : 'N/A';
        var dur = '—';
        if (row.Duration) {
          var d = new Date(row.Duration);
          dur = String(d.getUTCHours()).padStart(2,'0') + ':' + String(d.getUTCMinutes()).padStart(2,'0');
        }

        console.log('  ┌─── Cita #' + row.AppointmentId + ' ─────────────────────────');
        console.log('  │ Cliente:     ' + (row.FirstName || '') + ' ' + (row.LastName || '') + ' (ID: ' + row.CustomerId + ')');
        console.log('  │ Email:       ' + (row.Email || '—'));
        console.log('  │ Compañía:    ' + row.CompanyId);
        console.log('  │ Tipo:        ' + typeName);
        console.log('  │ Status:      ' + statusName);
        console.log('  │ Fecha cita:  ' + startStr);
        console.log('  │ Duración:    ' + dur);
        console.log('  │ Asignado a:  UserId ' + (row.UserId || '—'));
        console.log('  │ SaleOrderId: ' + (row.SaleOrderId || '—'));
        console.log('  │ Notas:       ' + (row.Remarks || '—'));
        console.log('  │ Creada:      ' + createdStr);
        console.log('  │ Creada por:  ' + (row.CreationBy || '—'));
        console.log('  └──────────────────────────────────────────────');
        console.log('');
      }
    }
  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    if (pool) { try { await pool.close(); } catch(e) {} }
    console.log('───────────────────────────────────────────────────────');
    console.log('Listo.\n');
  }
}

main();
