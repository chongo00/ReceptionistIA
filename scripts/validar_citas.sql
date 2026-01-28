-- Script de validación para verificar citas creadas por RecepcionistIA
-- Ejecutar en SSMS o con sqlcmd contra db_blindTest

USE db_blindTest;
GO

-- 1) Ver últimas 10 citas (con datos completos)
SELECT TOP 10
    a.Id AS AppointmentId,
    a.CustomerId,
    a.Type,
    CASE a.Type
        WHEN 0 THEN 'Quote'
        WHEN 1 THEN 'Install'
        WHEN 2 THEN 'Repair'
    END AS TypeName,
    a.Status,
    CASE a.Status
        WHEN 0 THEN 'Pending'
        WHEN 1 THEN 'Attended'
        WHEN 2 THEN 'Canceled'
    END AS StatusName,
    e.Start AS StartDate,
    e.Duration,
    e.UserId,
    e.Remarks,
    c.FirstName + ' ' + c.LastName AS CustomerName,
    c.Email AS CustomerEmail,
    c.Phone AS CustomerPhone
FROM [Schedule].[Appointments] a
JOIN [Schedule].[Events] e ON e.Id = a.Id
LEFT JOIN [Customer].[Customers] c ON c.Id = a.CustomerId
ORDER BY a.Id DESC;
GO

-- 2) Contar citas por tipo
SELECT 
    CASE Type
        WHEN 0 THEN 'Quote'
        WHEN 1 THEN 'Install'
        WHEN 2 THEN 'Repair'
    END AS TypeName,
    COUNT(*) AS Total
FROM [Schedule].[Appointments]
GROUP BY Type
ORDER BY Type;
GO

-- 3) Ver citas creadas hoy (útil después de pruebas)
SELECT 
    a.Id,
    a.CustomerId,
    c.FirstName + ' ' + c.LastName AS CustomerName,
    a.Type,
    e.Start,
    e.Duration
FROM [Schedule].[Appointments] a
JOIN [Schedule].[Events] e ON e.Id = a.Id
LEFT JOIN [Customer].[Customers] c ON c.Id = a.CustomerId
WHERE CAST(e.Start AS DATE) = CAST(GETDATE() AS DATE)
ORDER BY e.Start DESC;
GO
