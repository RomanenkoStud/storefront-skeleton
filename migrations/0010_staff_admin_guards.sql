-- Fail closed if actor/target state changed between validation and an atomic staff-management write.
CREATE TABLE staff_admin_guards (token TEXT PRIMARY KEY, valid INTEGER NOT NULL CHECK(valid=1));
