function gui(h, panel)
h.Callback = 'go';
set(h, 'KeyPressFcn', 'onkey');
uimenu('Callback', 'refresh_plots');
uicontrol('Callback', 'v = get(gcbo,''Value''); setv(v)');
uicontrol('Callback', 'show(panel)');
evalin('base', 'refresh_all');
end
