classdef Gen < handle
    properties
        Gain
        verbose
    end
    methods
        function all(obj)
            [t, a] = obj.build;
            if obj.verbose
            end
            g = obj.Gain;
        end
        function [t, a] = build(obj)
            t = 1; a = 2;
        end
    end
end
