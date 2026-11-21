import React, {createContext, useContext} from 'react';
export const StaffPermissions = createContext([]);
export const usePermission = () => { const permissions = useContext(StaffPermissions); return permission => permissions.includes(permission); };
