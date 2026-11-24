function gui()
uicontrol('Callback', 'arm_state(''a'',''x''); arm_state(''b'',''y''); close(gcbf);');
end
