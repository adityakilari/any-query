-- Yesterday's inpatient admissions with patient, attending provider and department (Oracle).
-- Schema: samples/schemas/clinic-oracle-columns.json (an ALL_TAB_COLUMNS export)
SELECT e.ENC_ID,
       p.FIRST_NM || ' ' || p.LAST_NM                        AS patient_name,
       NVL(prv.LAST_NM, 'Unassigned')                       AS attending,
       d.DEPT_NM,
       DECODE(e.ENC_STAT_CD, 'A', 'Admitted', 'D', 'Discharged', 'Other') AS status,
       ROUND(e.DSCHRG_DTTM - e.ADMIT_DTTM, 1)               AS stay_days,
       (SELECT COUNT(*) FROM CLINIC.ORD o WHERE o.ENC_ID = e.ENC_ID) AS order_count
FROM CLINIC.ENC e, CLINIC.PAT p, CLINIC.PRV prv, CLINIC.DEPT d
WHERE e.PAT_ID = p.PAT_ID
  AND e.ATTND_PRV_ID = prv.PRV_ID(+)
  AND e.DEPT_ID = d.DEPT_ID
  AND TRUNC(e.ADMIT_DTTM) = TRUNC(SYSDATE) - 1
  AND e.ENC_TYPE_CD = 'IP'
  AND ROWNUM <= 100
ORDER BY d.DEPT_NM, patient_name;
