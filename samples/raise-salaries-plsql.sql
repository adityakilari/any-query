-- Gives every active employee in a department a raise (Oracle PL/SQL procedure).
CREATE OR REPLACE PROCEDURE hr.raise_salaries (p_dept_id IN NUMBER, p_pct IN NUMBER DEFAULT 5) IS
  v_count   NUMBER := 0;
  v_total   NUMBER;
  v_bonus   NUMBER;
  CURSOR c_emps IS
    SELECT emp_id, salary_amt FROM employees WHERE dept_id = p_dept_id AND term_dt IS NULL;
BEGIN
  FOR r IN c_emps LOOP
    UPDATE employees SET salary_amt = salary_amt * (1 + p_pct / 100) WHERE emp_id = r.emp_id;
    v_count := v_count + 1;
    INSERT INTO audit_log (actor, action, logged_at) VALUES (USER, 'raise', SYSDATE);
  END LOOP;
  SELECT SUM(salary_amt) INTO v_total FROM employees WHERE dept_id = p_dept_id;
  IF v_count = 0 THEN
    RAISE_APPLICATION_ERROR(-20001, 'No employees in department');
  ELSIF v_total > 1000000 THEN
    DBMS_OUTPUT.PUT_LINE('Budget exceeded');
  END IF;
  EXECUTE IMMEDIATE 'DELETE FROM tmp_raises WHERE dept_id = ' || p_dept_id;
  COMMIT;
EXCEPTION
  WHEN OTHERS THEN
    NULL;
END raise_salaries;
/
