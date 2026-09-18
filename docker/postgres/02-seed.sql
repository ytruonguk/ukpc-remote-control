INSERT INTO device_groups (name, hmdm_group_id)
VALUES ('default', NULL);

-- password: admin123  (bcrypt cost 10)
INSERT INTO operators (username, display_name, password_hash, role, active)
VALUES (
  'admin',
  'Admin',
  '$2b$10$YmnkDiEgykVKOPr64kweg.x.n/b1D6Yj0nmH83YpSQHsZuiuVh.2.',
  'admin',
  true
);

INSERT INTO operator_group_access (operator_id, group_id)
SELECT o.id, g.id
FROM operators o
CROSS JOIN device_groups g
WHERE o.username = 'admin' AND g.name = 'default';
