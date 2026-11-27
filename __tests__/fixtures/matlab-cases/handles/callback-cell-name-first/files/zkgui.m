function zkgui(h)
set(h, 'ButtonDownFcn', {'zkcbset', 7});
uicontrol('Style', 'pushbutton', 'Callback', {'zkcbctor', 1});
t = timer('TimerFcn', {'zkcbtimer', 9});
h.CloseRequestFcn = {'zkcbprop', 8};
set(h, 'KeyPressFcn', {"zkcbstr", 2});
set(h, 'ButtonDownFcn', {'zkpk.zkcbpkg', 3});
nm = 'zkcbvar';
set(h, 'DeleteFcn', {nm, 4});
set(h, 'KeyPressFcn', {'zkcbidx(1)', 2});
c = {'zkcbdata', 5};
disp(c);
b = uibutton(h, 'ButtonPushedFcn', {'zkcbbtn', 1});
d = uidropdown(h);
d.DeleteFcn = {'zkcbdrop', 2};
s = struct('Callback', {'zkcbst', 1});
set(h, 'KeyPressFcn', {'zkcbnone', ...
  2});
end
